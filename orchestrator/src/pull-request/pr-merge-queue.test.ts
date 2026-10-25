import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { db } from '../database/db.ts'
import type { AdmissionDecision } from './admission-decision.ts'
import {
  MERGE_QUEUE_DEQUEUE_CONFIRM_MS,
  MERGE_QUEUE_WAIT_MS,
  type MergeQueueObservation,
} from './merge-queue-decision.ts'
import type { PullRequestChange } from './pr-admission.ts'
import {
  mergePullRequest,
  type PullRequestMergeAdapter,
  type PullRequestMergeFacts,
} from './pr-merge.ts'

const cwd = fileURLToPath(new URL('../../..', import.meta.url)).replace(/\/$/, '')
const pullRequest: PullRequestMergeFacts = {
  nodeId: 'PR_node_id',
  number: 42,
  headCommit: 'head-commit',
  headBranch: 'DEV-1358-queue',
  baseBranch: 'main',
  title: 'Queue this pull request',
  state: 'OPEN',
}

function registerProject(requiredChecks: string[]): void {
  db()
    .query('INSERT INTO project (record_id,name,path,stack,settings) VALUES (?,?,?,?,?)')
    .run(
      newRecordId(),
      'merge-queue-fixture',
      cwd,
      'bun',
      JSON.stringify({
        trunk: 'main',
        release: { rungs: [], mergeMethod: 'squash', requiredChecks, mergeQueue: true },
      }),
    )
}

function adapter(input: {
  queueStates: MergeQueueObservation[]
  enqueue?: (cwd: string, number: number, headCommit: string) => void
  requeue?: (cwd: string, nodeId: string, headCommit: string) => void
  failedMergeGroupRun?: () => { id: number; url: string } | null
  wait?: (milliseconds: number) => void
  now?: () => number
  landingState?: () => { remoteLandingTip: string; mergeBase: string }
}): PullRequestMergeAdapter {
  return {
    view: () => pullRequest,
    checks: () => [
      { name: 'ci', bucket: 'pass', state: 'SUCCESS', link: 'https://checks.example/ci' },
    ],
    landingState: input.landingState ?? (() => ({ remoteLandingTip: 'base', mergeBase: 'base' })),
    hasCommit: () => true,
    admission: () => ({
      change: { branch: pullRequest.headBranch } as PullRequestChange,
      decision: {
        complete: true,
        overrideId: null,
        triage: { complete: true, snapshot: {} } as AdmissionDecision['triage'],
      },
    }),
    recordAdmission: () => null,
    merge: () => 'unexpected-direct-merge',
    queueState: () => input.queueStates.shift()!,
    enqueue: (enqueueCwd, number, headCommit) => input.enqueue?.(enqueueCwd, number, headCommit),
    requeue: (requeueCwd, nodeId, headCommit) => input.requeue?.(requeueCwd, nodeId, headCommit),
    failedMergeGroupRun: () =>
      input.failedMergeGroupRun?.() ?? {
        id: 9876,
        url: 'https://github.example/actions/runs/9876',
      },
    now: input.now ?? Date.now,
    wait: (milliseconds) => input.wait?.(milliseconds),
  }
}

test('a declared merge queue enqueues after proof and returns the eventual merge commit', () => {
  registerProject(['ci'])
  const calls: string[] = []
  const enqueueArguments: unknown[][] = []
  expect(
    mergePullRequest(
      '42',
      cwd,
      adapter({
        queueStates: [
          { pullRequestState: 'OPEN', mergeCommit: null, entryState: null },
          { pullRequestState: 'OPEN', mergeCommit: null, entryState: null },
          { pullRequestState: 'OPEN', mergeCommit: null, entryState: 'AWAITING_CHECKS' },
          { pullRequestState: 'MERGED', mergeCommit: 'queued-merge-oid', entryState: null },
        ],
        enqueue: (...args) => {
          calls.push('enqueue')
          enqueueArguments.push(args)
        },
        wait: () => calls.push('wait'),
      }),
    ),
  ).toEqual({ output: 'queued-merge-oid', exitCode: 0 })
  expect(calls).toEqual(['enqueue', 'wait', 'wait'])
  expect(enqueueArguments).toEqual([[cwd, 42, 'head-commit']])
})

test('an already-queued pull request is only waited for', () => {
  registerProject(['ci'])
  let enqueued = false
  expect(
    mergePullRequest(
      '42',
      cwd,
      adapter({
        queueStates: [
          { pullRequestState: 'OPEN', mergeCommit: null, entryState: 'QUEUED' },
          { pullRequestState: 'MERGED', mergeCommit: 'queued-merge-oid', entryState: null },
        ],
        enqueue: () => {
          enqueued = true
        },
      }),
    ),
  ).toEqual({ output: 'queued-merge-oid', exitCode: 0 })
  expect(enqueued).toBe(false)
})

test('a failed first observation is dequeued and enqueued once before merging', () => {
  registerProject(['ci'])
  const requeueArguments: unknown[][] = []
  const mutations: string[] = []
  const result = mergePullRequest(
    '42',
    cwd,
    adapter({
      queueStates: [
        { pullRequestState: 'OPEN', mergeCommit: null, entryState: 'UNMERGEABLE' },
        { pullRequestState: 'OPEN', mergeCommit: null, entryState: 'QUEUED' },
        { pullRequestState: 'MERGED', mergeCommit: 'queued-merge-oid', entryState: null },
      ],
      requeue: (...args) => {
        requeueArguments.push(args)
        mutations.push('dequeue', 'enqueue')
      },
    }),
  )
  expect(requeueArguments).toEqual([[cwd, 'PR_node_id', 'head-commit']])
  expect(mutations).toEqual(['dequeue', 'enqueue'])
  expect(result).toEqual({
    output:
      'requeued #42 at head-commit after failed merge-group run 9876 (https://github.example/actions/runs/9876)\nqueued-merge-oid',
    exitCode: 0,
  })
})

test('a persistent failed entry refuses with the failed run and both remedies', () => {
  registerProject(['ci'])
  let clock = 0
  expect(() =>
    mergePullRequest(
      '42',
      cwd,
      adapter({
        queueStates: [
          { pullRequestState: 'OPEN', mergeCommit: null, entryState: 'UNMERGEABLE' },
          { pullRequestState: 'OPEN', mergeCommit: null, entryState: 'UNMERGEABLE' },
          { pullRequestState: 'OPEN', mergeCommit: null, entryState: 'UNMERGEABLE' },
        ],
        now: () => clock,
        wait: () => {
          clock = MERGE_QUEUE_DEQUEUE_CONFIRM_MS
        },
      }),
    ),
  ).toThrow(
    `failed merge-group run 9876 (https://github.example/actions/runs/9876); cleared by: push a fix if the check failure is real, or re-run ${PLATFORM_SLUG} pr merge 42 to requeue the unchanged head if it flaked`,
  )
})

test('a failed-run lookup error does not block the requeue', () => {
  registerProject(['ci'])
  let requeues = 0
  const result = mergePullRequest(
    '42',
    cwd,
    adapter({
      queueStates: [
        { pullRequestState: 'OPEN', mergeCommit: null, entryState: 'UNMERGEABLE' },
        { pullRequestState: 'OPEN', mergeCommit: null, entryState: 'QUEUED' },
        { pullRequestState: 'MERGED', mergeCommit: 'queued-merge-oid', entryState: null },
      ],
      requeue: () => {
        requeues += 1
      },
      failedMergeGroupRun: () => {
        throw new Error('actions API unavailable')
      },
    }),
  )
  expect(requeues).toBe(1)
  expect(result.output).toContain(
    'failed merge-group run could not be read: actions API unavailable',
  )
})

test('a pull request removed from an established queue refuses with the retry command', () => {
  registerProject(['ci'])
  let clock = 0
  expect(() =>
    mergePullRequest(
      '42',
      cwd,
      adapter({
        queueStates: [
          { pullRequestState: 'OPEN', mergeCommit: null, entryState: 'QUEUED' },
          { pullRequestState: 'OPEN', mergeCommit: null, entryState: null },
          { pullRequestState: 'OPEN', mergeCommit: null, entryState: null },
        ],
        now: () => clock,
        wait: (milliseconds) => {
          clock += milliseconds === 10_000 ? MERGE_QUEUE_DEQUEUE_CONFIRM_MS : milliseconds
        },
      }),
    ),
  ).toThrow(
    `left the merge queue without merging; cleared by: fix the dequeue reason, then ${PLATFORM_SLUG} pr merge 42`,
  )
})

test('a pull request merged during the vanished-entry transition completes', () => {
  registerProject(['ci'])
  expect(
    mergePullRequest(
      '42',
      cwd,
      adapter({
        queueStates: [
          { pullRequestState: 'OPEN', mergeCommit: null, entryState: 'QUEUED' },
          { pullRequestState: 'OPEN', mergeCommit: null, entryState: null },
          { pullRequestState: 'MERGED', mergeCommit: 'queued-merge-oid', entryState: null },
        ],
      }),
    ),
  ).toEqual({ output: 'queued-merge-oid', exitCode: 0 })
})

test('a closed pull request refuses immediately after an established queue', () => {
  registerProject(['ci'])
  expect(() =>
    mergePullRequest(
      '42',
      cwd,
      adapter({
        queueStates: [
          { pullRequestState: 'OPEN', mergeCommit: null, entryState: 'QUEUED' },
          { pullRequestState: 'CLOSED', mergeCommit: null, entryState: null },
        ],
      }),
    ),
  ).toThrow('left the merge queue without merging')
})

test('an enqueue failure reports the queue operation and its specific remedy', () => {
  registerProject(['ci'])
  expect(() =>
    mergePullRequest(
      '42',
      cwd,
      adapter({
        queueStates: [{ pullRequestState: 'OPEN', mergeCommit: null, entryState: null }],
        enqueue: () => {
          throw new Error(
            'Auto merge is not allowed for this repository (enablePullRequestAutoMerge)',
          )
        },
      }),
    ),
  ).toThrow(
    `refusing merge: pull request #42 could not be added to the merge queue: Auto merge is not allowed for this repository (enablePullRequestAutoMerge); cleared by: enable auto-merge on the repository (allow_auto_merge), then ${PLATFORM_SLUG} pr merge 42`,
  )
})

test('a queue wait is bounded and tells the operator to rerun the merge command', () => {
  registerProject(['ci'])
  let clock = 0
  expect(() =>
    mergePullRequest(
      '42',
      cwd,
      adapter({
        queueStates: [
          { pullRequestState: 'OPEN', mergeCommit: null, entryState: 'QUEUED' },
          { pullRequestState: 'OPEN', mergeCommit: null, entryState: 'QUEUED' },
        ],
        now: () => clock,
        wait: () => {
          clock = MERGE_QUEUE_WAIT_MS
        },
      }),
    ),
  ).toThrow(`re-run ${PLATFORM_SLUG} pr merge 42, which will keep waiting if it is already queued`)
})

test('a declared merge queue exempts a local-gate proof from moved landing state', () => {
  registerProject([])
  db()
    .query(
      `INSERT INTO gate_execution
        (record_id,requested_at,finished_at,exit_code,timed_out,elapsed_ms,output_tail,head_commit,cwd)
       VALUES (?, '2026-10-16','2026-10-16',0,0,100,'passed',?,?)`,
    )
    .run(newRecordId(), pullRequest.headCommit, cwd)
  let readLandingState = false
  expect(
    mergePullRequest(
      '42',
      cwd,
      adapter({
        queueStates: [
          { pullRequestState: 'MERGED', mergeCommit: 'queued-merge-oid', entryState: null },
        ],
        landingState: () => {
          readLandingState = true
          return { remoteLandingTip: 'new-base', mergeBase: 'old-base' }
        },
      }),
    ),
  ).toEqual({ output: 'queued-merge-oid', exitCode: 0 })
  expect(readLandingState).toBe(false)
})
