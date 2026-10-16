import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { db } from '../database/db.ts'
import type { AdmissionDecision } from './admission-decision.ts'
import type { MergeQueueObservation } from './merge-queue-decision.ts'
import type { PullRequestChange } from './pr-admission.ts'
import {
  MERGE_QUEUE_WAIT_MS,
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
    .query('INSERT INTO project (name,path,stack,settings) VALUES (?,?,?,?)')
    .run(
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
  enqueue?: () => void
  wait?: () => void
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
    enqueue: () => input.enqueue?.(),
    now: input.now ?? Date.now,
    wait: () => input.wait?.(),
  }
}

test('a declared merge queue enqueues after proof and returns the eventual merge commit', () => {
  registerProject(['ci'])
  const calls: string[] = []
  expect(
    mergePullRequest(
      '42',
      cwd,
      adapter({
        queueStates: [
          { pullRequestState: 'OPEN', mergeCommit: null, entryState: null },
          { pullRequestState: 'OPEN', mergeCommit: null, entryState: 'AWAITING_CHECKS' },
          { pullRequestState: 'MERGED', mergeCommit: 'queued-merge-oid', entryState: null },
        ],
        enqueue: () => calls.push('enqueue'),
        wait: () => calls.push('wait'),
      }),
    ),
  ).toBe('queued-merge-oid')
  expect(calls).toEqual(['enqueue', 'wait'])
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
  ).toBe('queued-merge-oid')
  expect(enqueued).toBe(false)
})

test('a pull request removed from an established queue refuses with the retry command', () => {
  registerProject(['ci'])
  expect(() =>
    mergePullRequest(
      '42',
      cwd,
      adapter({
        queueStates: [
          { pullRequestState: 'OPEN', mergeCommit: null, entryState: 'QUEUED' },
          { pullRequestState: 'OPEN', mergeCommit: null, entryState: null },
        ],
      }),
    ),
  ).toThrow(
    `left the merge queue without merging; cleared by: fix the dequeue reason, then ${PLATFORM_SLUG} pr merge 42`,
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
  ).toBe('queued-merge-oid')
  expect(readLandingState).toBe(false)
})
