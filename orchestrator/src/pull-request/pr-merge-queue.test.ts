import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { db } from '../database/db.ts'
import type { TriageDecision } from '../review-funnel/review-funnel-admission-evidence.ts'
import type { PullRequestCheck } from './merge-decision.ts'
import {
  MERGE_QUEUE_DEQUEUE_CONFIRM_MS,
  MERGE_QUEUE_REQUEUE_CONFIRM_MS,
  MERGE_QUEUE_WAIT_MS,
  type MergeQueueObservation,
} from './merge-queue-decision.ts'
import type { EvaluatedAdmission, PullRequestChange } from './pr-admission.ts'
import {
  mergePullRequest,
  type PullRequestMergeAdapter,
  type PullRequestMergeFacts,
} from './pr-merge.ts'

const cwd = fileURLToPath(new URL('../../..', import.meta.url)).replace(/\/$/, '')
const pullRequest: PullRequestMergeFacts = {
  nodeId: 'PR_node_id',
  number: 42,
  url: 'https://github.example/pulls/42',
  headCommit: 'head-commit',
  headBranch: 'DEV-1358-queue',
  baseBranch: 'main',
  title: 'Queue this pull request',
  state: 'OPEN',
  mergeStateStatus: 'CLEAN',
  mergeCommit: null,
}
const pathSet = ['orchestrator/src/pull-request/pr-merge.ts']

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

type TestQueueObservation = Omit<MergeQueueObservation, 'enqueuedAt' | 'removalReason'> & {
  enqueuedAt?: string | null
  removalReason?: string | null
}

function adapter(input: {
  queueStates: TestQueueObservation[]
  enqueue?: (cwd: string, number: number, headCommit: string) => void
  requeue?: (cwd: string, nodeId: string, headCommit: string) => void
  failedMergeGroupRun?: (
    cwd: string,
    repository: string,
    baseBranch: string,
    pullRequestNumber: number,
    enqueuedAt: string,
  ) => { id: number; url: string; conclusion: string } | null
  wait?: (milliseconds: number) => void
  now?: () => number
  landingState?: () => { remoteLandingTip: string; mergeBase: string }
  landingComparison?: () => string
  repository?: string | null
  checks?: PullRequestCheck[]
}): PullRequestMergeAdapter {
  return {
    repository: () => (input.repository === undefined ? 'example/repository' : input.repository),
    view: () => pullRequest,
    releaseDecision: () => ({ decided: true, required: [], rungs: [], error: null }),
    checks: () =>
      input.checks ?? [
        { name: 'ci', bucket: 'pass', state: 'SUCCESS', link: 'https://checks.example/ci' },
      ],
    landingState: input.landingState ?? (() => ({ remoteLandingTip: 'base', mergeBase: 'base' })),
    hasCommit: () => true,
    admission: () => ({
      change: {
        branch: pullRequest.headBranch,
        base: 'base',
        group: { pathSet },
      } as PullRequestChange,
      decision: {
        kind: 'measured',
        complete: true,
        overrideId: null,
        overrideReason: null,
        triage: { complete: true, snapshot: {} } as TriageDecision,
      } as EvaluatedAdmission,
    }),
    recordAdmission: () => null,
    postMergeChange: () =>
      ({
        branch: pullRequest.headBranch,
        base: 'base',
        group: { pathSet },
      }) as PullRequestChange,
    merge: () => 'unexpected-direct-merge',
    mergeCommit: () => 'unexpected-direct-merge-commit',
    queueState: () => {
      const state = input.queueStates.shift()!
      return {
        ...state,
        enqueuedAt:
          state.enqueuedAt !== undefined
            ? state.enqueuedAt
            : state.entryState === null
              ? null
              : '2026-10-24T10:00:00Z',
        removalReason: state.removalReason ?? null,
      }
    },
    landingComparison: input.landingComparison ?? (() => 'identical'),
    enqueue: (enqueueCwd, number, headCommit) => input.enqueue?.(enqueueCwd, number, headCommit),
    requeue: (requeueCwd, nodeId, headCommit) => input.requeue?.(requeueCwd, nodeId, headCommit),
    failedMergeGroupRun: (...args) =>
      input.failedMergeGroupRun
        ? input.failedMergeGroupRun(...args)
        : {
            id: 9876,
            url: 'https://github.example/actions/runs/9876',
            conclusion: 'failure',
          },
    now: input.now ?? Date.now,
    wait: (milliseconds) => input.wait?.(milliseconds),
    postLanding: {
      changedPaths: () => [],
      entryClosure: () => new Map(),
      mainHead: () => 'fixture-main-head',
      releaseBeforeMove: async () => ({ required: [], releases: [], satisfied: true }),
      moveMain: () => {},
      fence: () => {},
      handOff: (payload) => ({
        output: [payload.mergeCommit, payload.requeueOutput].filter(Boolean).join('\n'),
        exitCode: 0,
      }),
    },
  }
}

test('a declared merge queue enqueues after proof and returns the eventual merge commit', async () => {
  registerProject(['ci'])
  const calls: string[] = []
  const enqueueArguments: unknown[][] = []
  expect(
    await mergePullRequest(
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
  ).toEqual({
    output: 'queued-merge-oid',
    exitCode: 0,
    pullRequestNumber: 42,
    mergeCommit: 'queued-merge-oid',
    headBranch: 'DEV-1358-queue',
  })
  expect(calls).toEqual(['enqueue', 'wait', 'wait'])
  expect(enqueueArguments).toEqual([[cwd, 42, 'head-commit']])
})

test('an already-queued pull request is only waited for', async () => {
  registerProject(['ci'])
  let enqueued = false
  expect(
    await mergePullRequest(
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
  ).toEqual({
    output: 'queued-merge-oid',
    exitCode: 0,
    pullRequestNumber: 42,
    mergeCommit: 'queued-merge-oid',
    headBranch: 'DEV-1358-queue',
  })
  expect(enqueued).toBe(false)
})

test('a non-proving landing comparison is retried until identical', async () => {
  registerProject(['ci'])
  const comparisons = ['diverged', 'identical']
  expect(
    await mergePullRequest(
      '42',
      cwd,
      adapter({
        queueStates: [
          { pullRequestState: 'MERGED', mergeCommit: 'queued-merge-oid', entryState: null },
          { pullRequestState: 'MERGED', mergeCommit: 'queued-merge-oid', entryState: null },
        ],
        landingComparison: () => comparisons.shift()!,
      }),
    ),
  ).toMatchObject({ mergeCommit: 'queued-merge-oid' })
  expect(comparisons).toEqual([])
})

test('a non-proving landing comparison refuses with landed wording at the deadline', async () => {
  registerProject(['ci'])
  let clock = 0
  expect(
    async () =>
      await mergePullRequest(
        '42',
        cwd,
        adapter({
          queueStates: [
            { pullRequestState: 'MERGED', mergeCommit: 'queued-merge-oid', entryState: null },
            { pullRequestState: 'MERGED', mergeCommit: 'queued-merge-oid', entryState: null },
          ],
          landingComparison: () => 'ahead',
          now: () => clock,
          wait: () => {
            clock = MERGE_QUEUE_WAIT_MS
          },
        }),
      ),
  ).toThrow(
    /GitHub reports pull request #42 merged as queued-merge-oid.*last status: ahead.*re-run/,
  )
})

test('a throwing landing comparison is retried until behind', async () => {
  registerProject(['ci'])
  let comparisons = 0
  expect(
    await mergePullRequest(
      '42',
      cwd,
      adapter({
        queueStates: [
          { pullRequestState: 'MERGED', mergeCommit: 'queued-merge-oid', entryState: null },
          { pullRequestState: 'MERGED', mergeCommit: 'queued-merge-oid', entryState: null },
        ],
        landingComparison: () => {
          comparisons += 1
          if (comparisons === 1) throw new Error('temporary compare failure')
          return 'behind'
        },
      }),
    ),
  ).toMatchObject({ mergeCommit: 'queued-merge-oid' })
  expect(comparisons).toBe(2)
})

test('a throwing landing comparison refuses with its error at the deadline', async () => {
  registerProject(['ci'])
  let clock = 0
  expect(
    async () =>
      await mergePullRequest(
        '42',
        cwd,
        adapter({
          queueStates: [
            { pullRequestState: 'MERGED', mergeCommit: 'queued-merge-oid', entryState: null },
            { pullRequestState: 'MERGED', mergeCommit: 'queued-merge-oid', entryState: null },
          ],
          landingComparison: () => {
            throw new Error('temporary compare failure')
          },
          now: () => clock,
          wait: () => {
            clock = MERGE_QUEUE_WAIT_MS
          },
        }),
      ),
  ).toThrow(/merged as queued-merge-oid.*last error: temporary compare failure.*re-run/)
})

test('a merged pull request waits for GitHub to publish its merge commit', async () => {
  registerProject(['ci'])
  expect(
    await mergePullRequest(
      '42',
      cwd,
      adapter({
        queueStates: [
          { pullRequestState: 'MERGED', mergeCommit: null, entryState: null },
          { pullRequestState: 'MERGED', mergeCommit: 'queued-merge-oid', entryState: null },
        ],
      }),
    ),
  ).toMatchObject({ mergeCommit: 'queued-merge-oid' })
})

test('a merged pull request without a published merge commit refuses at the deadline', async () => {
  registerProject(['ci'])
  let clock = 0
  expect(
    async () =>
      await mergePullRequest(
        '42',
        cwd,
        adapter({
          queueStates: [
            { pullRequestState: 'MERGED', mergeCommit: null, entryState: null },
            { pullRequestState: 'MERGED', mergeCommit: null, entryState: null },
          ],
          now: () => clock,
          wait: () => {
            clock = MERGE_QUEUE_WAIT_MS
          },
        }),
      ),
  ).toThrow(/reports pull request #42 merged but has published no merge commit.*re-run/)
})

test('a failed first observation makes one requeue call with the node id and head', async () => {
  registerProject(['ci'])
  const requeueArguments: unknown[][] = []
  const failedRunArguments: unknown[][] = []
  const result = await mergePullRequest(
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
      },
      failedMergeGroupRun: (...args) => {
        failedRunArguments.push(args)
        return {
          id: 9876,
          url: 'https://github.example/actions/runs/9876',
          conclusion: 'failure',
        }
      },
    }),
  )
  expect(requeueArguments).toEqual([[cwd, 'PR_node_id', 'head-commit']])
  expect(failedRunArguments).toEqual([
    [cwd, 'example/repository', 'main', 42, '2026-10-24T10:00:00Z'],
  ])
  expect(result).toEqual({
    output:
      'queued-merge-oid\nrequeued #42 at head-commit after failure merge-group run 9876 (https://github.example/actions/runs/9876)',
    exitCode: 0,
    pullRequestNumber: 42,
    mergeCommit: 'queued-merge-oid',
    headBranch: 'DEV-1358-queue',
  })
})

test('a persistent failed entry refuses with the failed run and both remedies', async () => {
  registerProject(['ci'])
  let clock = 0
  expect(
    async () =>
      await mergePullRequest(
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
            clock = MERGE_QUEUE_REQUEUE_CONFIRM_MS
          },
        }),
      ),
  ).toThrow(
    `failure merge-group run 9876 (https://github.example/actions/runs/9876); cleared by: push a fix if the check failure is real, or re-run ${PLATFORM_SLUG} pr merge 42 to requeue the unchanged head if it flaked`,
  )
})

test('a failed-run lookup error does not block the requeue', async () => {
  registerProject(['ci'])
  let requeues = 0
  const result = await mergePullRequest(
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

test('a requeue failure refuses with the requeue, failed-run evidence, and remedy', async () => {
  registerProject(['ci'])
  expect(
    async () =>
      await mergePullRequest(
        '42',
        cwd,
        adapter({
          queueStates: [{ pullRequestState: 'OPEN', mergeCommit: null, entryState: 'UNMERGEABLE' }],
          requeue: () => {
            throw new Error('GraphQL mutation refused')
          },
        }),
      ),
  ).toThrow(
    `refusing merge: pull request #42 could not be requeued after failure merge-group run 9876 (https://github.example/actions/runs/9876): GraphQL mutation refused; cleared by: fix the reported forge condition, then ${PLATFORM_SLUG} pr merge 42`,
  )
})

test('a failed entry without an enqueue time does not search workflow runs', async () => {
  registerProject(['ci'])
  let searched = false
  const result = await mergePullRequest(
    '42',
    cwd,
    adapter({
      queueStates: [
        {
          pullRequestState: 'OPEN',
          mergeCommit: null,
          entryState: 'UNMERGEABLE',
          enqueuedAt: null,
        },
        { pullRequestState: 'OPEN', mergeCommit: null, entryState: 'QUEUED' },
        { pullRequestState: 'MERGED', mergeCommit: 'queued-merge-oid', entryState: null },
      ],
      failedMergeGroupRun: () => {
        searched = true
        return null
      },
    }),
  )
  expect(searched).toBe(false)
  expect(result.output).toContain(
    'failed merge-group run could not be read: the queue entry has no enqueue time',
  )
})

test('a pull request removed from an established queue stops and reports the reason', async () => {
  registerProject(['ci'])
  expect(
    async () =>
      await mergePullRequest(
        '42',
        cwd,
        adapter({
          queueStates: [
            { pullRequestState: 'OPEN', mergeCommit: null, entryState: 'QUEUED' },
            {
              pullRequestState: 'OPEN',
              mergeCommit: null,
              entryState: null,
              removalReason: 'BASE_BRANCH_UPDATED',
            },
          ],
          failedMergeGroupRun: () => null,
        }),
      ),
  ).toThrow(
    `dequeued without a failed check (reason: BASE_BRANCH_UPDATED); cleared by: ${PLATFORM_SLUG} pr merge 42`,
  )
})

test('a merge-conflict removal names merge, push, and requeue as its remedy', async () => {
  registerProject(['ci'])
  expect(
    async () =>
      await mergePullRequest(
        '42',
        cwd,
        adapter({
          queueStates: [
            { pullRequestState: 'OPEN', mergeCommit: null, entryState: 'QUEUED' },
            {
              pullRequestState: 'OPEN',
              mergeCommit: null,
              entryState: null,
              removalReason: 'merge_conflict',
            },
          ],
          failedMergeGroupRun: () => null,
        }),
      ),
  ).toThrow(
    `dequeued without a failed check (reason: merge_conflict); cleared by: merge origin/main into the pull-request branch, push it, then ${PLATFORM_SLUG} pr merge 42`,
  )
})

test('a merged removal completes when pull-request state catches up inside confirmation', async () => {
  registerProject(['ci'])
  expect(
    await mergePullRequest(
      '42',
      cwd,
      adapter({
        queueStates: [
          { pullRequestState: 'OPEN', mergeCommit: null, entryState: 'QUEUED' },
          {
            pullRequestState: 'OPEN',
            mergeCommit: null,
            entryState: null,
            removalReason: 'merged',
          },
          { pullRequestState: 'MERGED', mergeCommit: 'queued-merge-oid', entryState: null },
        ],
        failedMergeGroupRun: () => null,
      }),
    ),
  ).toMatchObject({ mergeCommit: 'queued-merge-oid' })
})

test('a merged removal past confirmation keeps polling until GitHub reports MERGED', async () => {
  registerProject(['ci'])
  let clock = 0
  let waits = 0
  expect(
    await mergePullRequest(
      '42',
      cwd,
      adapter({
        queueStates: [
          { pullRequestState: 'OPEN', mergeCommit: null, entryState: 'QUEUED' },
          {
            pullRequestState: 'OPEN',
            mergeCommit: null,
            entryState: null,
            removalReason: 'merged',
          },
          {
            pullRequestState: 'OPEN',
            mergeCommit: null,
            entryState: null,
            removalReason: 'merged',
          },
          { pullRequestState: 'MERGED', mergeCommit: 'queued-merge-oid', entryState: null },
        ],
        now: () => clock,
        wait: () => {
          waits += 1
          if (waits === 2) clock = MERGE_QUEUE_DEQUEUE_CONFIRM_MS
        },
        failedMergeGroupRun: () => null,
      }),
    ),
  ).toMatchObject({ mergeCommit: 'queued-merge-oid' })
})

test('a stale merge-conflict removal from before this enqueue does not refuse', async () => {
  registerProject(['ci'])
  const removedAt = '2026-10-24T10:00:00Z'
  const now = Date.parse('2026-10-24T10:00:01Z')
  expect(
    await mergePullRequest(
      '42',
      cwd,
      adapter({
        queueStates: [
          {
            pullRequestState: 'OPEN',
            mergeCommit: null,
            entryState: null,
            removalReason: 'merge_conflict',
            removedAt,
          },
          {
            pullRequestState: 'OPEN',
            mergeCommit: null,
            entryState: null,
            removalReason: 'merge_conflict',
            removedAt,
          },
          { pullRequestState: 'OPEN', mergeCommit: null, entryState: 'QUEUED' },
          { pullRequestState: 'MERGED', mergeCommit: 'queued-merge-oid', entryState: null },
        ],
        now: () => now,
        failedMergeGroupRun: () => null,
      }),
    ),
  ).toMatchObject({ mergeCommit: 'queued-merge-oid' })
})

test('a merge-conflict dequeue with a failed run keeps the reasoned remedy and appends evidence', async () => {
  registerProject(['ci'])
  expect(
    async () =>
      await mergePullRequest(
        '42',
        cwd,
        adapter({
          queueStates: [
            { pullRequestState: 'OPEN', mergeCommit: null, entryState: 'QUEUED' },
            {
              pullRequestState: 'OPEN',
              mergeCommit: null,
              entryState: null,
              removalReason: 'merge_conflict',
            },
          ],
        }),
      ),
  ).toThrow(
    `dequeued without a failed check (reason: merge_conflict); failure merge-group run 9876 (https://github.example/actions/runs/9876); cleared by: merge origin/main into the pull-request branch, push it, then ${PLATFORM_SLUG} pr merge 42`,
  )
})

test('a failed-checks dequeue keeps the failed-check remedy and appends run evidence', async () => {
  registerProject(['ci'])
  expect(
    async () =>
      await mergePullRequest(
        '42',
        cwd,
        adapter({
          queueStates: [
            { pullRequestState: 'OPEN', mergeCommit: null, entryState: 'QUEUED' },
            {
              pullRequestState: 'OPEN',
              mergeCommit: null,
              entryState: null,
              removalReason: 'failed_checks',
            },
          ],
        }),
      ),
  ).toThrow(
    `failed in the merge queue (reason: failed_checks); failure merge-group run 9876 ` +
      `(https://github.example/actions/runs/9876); cleared by: push a fix if the check failure is real, ` +
      `or re-run ${PLATFORM_SLUG} pr merge 42 to requeue the unchanged head if it flaked`,
  )
})

test('a closed pull request refuses after the bounded re-poll', async () => {
  registerProject(['ci'])
  let clock = 0
  expect(
    async () =>
      await mergePullRequest(
        '42',
        cwd,
        adapter({
          queueStates: [
            { pullRequestState: 'OPEN', mergeCommit: null, entryState: 'QUEUED' },
            { pullRequestState: 'CLOSED', mergeCommit: null, entryState: null },
            { pullRequestState: 'CLOSED', mergeCommit: null, entryState: null },
          ],
          now: () => clock,
          wait: () => {
            clock += 30_000
          },
        }),
      ),
  ).toThrow('closed without merging')
})

test('a closed observation completes when the bounded re-fetch reports MERGED', async () => {
  registerProject(['ci'])
  expect(
    await mergePullRequest(
      '42',
      cwd,
      adapter({
        queueStates: [
          { pullRequestState: 'OPEN', mergeCommit: null, entryState: 'QUEUED' },
          { pullRequestState: 'CLOSED', mergeCommit: null, entryState: null },
          { pullRequestState: 'MERGED', mergeCommit: 'queued-merge-oid', entryState: null },
        ],
      }),
    ),
  ).toMatchObject({ mergeCommit: 'queued-merge-oid' })
})

test('an enqueue failure reports the queue operation and its specific remedy', async () => {
  registerProject(['ci'])
  expect(
    async () =>
      await mergePullRequest(
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

test('a GitHub branch-policy enqueue refusal names pending checks and does not restore forge access', async () => {
  registerProject(['ci'])
  expect(
    async () =>
      await mergePullRequest(
        '42',
        cwd,
        adapter({
          queueStates: [{ pullRequestState: 'OPEN', mergeCommit: null, entryState: null }],
          checks: [
            {
              name: 'Check',
              bucket: 'pending',
              state: 'IN_PROGRESS',
              link: 'https://checks.example/check',
            },
            {
              name: 'ci',
              bucket: 'pass',
              state: 'SUCCESS',
              link: 'https://checks.example/ci',
            },
          ],
          enqueue: () => {
            throw new Error(
              'merge-queue enqueue failed: GraphQL: Base branch policy prohibits the merge (mergePullRequest)',
            )
          },
        }),
      ),
  ).toThrow(
    `refusing merge: GitHub's branch policy blocks the merge: Check pending; cleared by: wait for pending checks, then rerun ${PLATFORM_SLUG} pr merge 42`,
  )
})

test('a queue wait is bounded and tells the operator to rerun the merge command', async () => {
  registerProject(['ci'])
  let clock = 0
  expect(
    async () =>
      await mergePullRequest(
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

test('a declared merge queue exempts a local-gate proof from moved landing state', async () => {
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
    await mergePullRequest(
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
  ).toEqual({
    output: 'queued-merge-oid',
    exitCode: 0,
    pullRequestNumber: 42,
    mergeCommit: 'queued-merge-oid',
    headBranch: 'DEV-1358-queue',
  })
  expect(readLandingState).toBe(false)
})
