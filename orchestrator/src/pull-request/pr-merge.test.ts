import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { db } from '../database/db.ts'
import type { AdmissionDecision } from './admission-decision.ts'
import type { PullRequestCheck } from './merge-decision.ts'
import { type PullRequestChange, recordMergeAdmission } from './pr-admission.ts'
import {
  mergePullRequest,
  type PullRequestMergeAdapter,
  type PullRequestMergeFacts,
} from './pr-merge.ts'

const cwd = fileURLToPath(new URL('../../..', import.meta.url)).replace(/\/$/, '')

function registerProject(requiredChecks: string[], mergeQueue = false): void {
  db()
    .query(
      'INSERT INTO project (record_id,name,path,stack,settings) VALUES (lower(hex(randomblob(4))) || char(45) || lower(hex(randomblob(2))) || char(45,55) || substr(lower(hex(randomblob(2))),2) || char(45,56) || substr(lower(hex(randomblob(2))),2) || char(45) || lower(hex(randomblob(6))),?,?,?,?)',
    )
    .run(
      'merge-fixture',
      cwd,
      'bun',
      JSON.stringify({
        trunk: 'main',
        release: { rungs: [], mergeMethod: 'squash', requiredChecks, mergeQueue },
      }),
    )
}

const pullRequest: PullRequestMergeFacts = {
  nodeId: 'PR_node_id',
  number: 42,
  headCommit: 'head-commit',
  headBranch: 'DEV-1255-admission',
  baseBranch: 'main',
  title: 'Prove the pull request head',
  state: 'OPEN',
}

function adapter(
  input: {
    view?: (target: string) => PullRequestMergeFacts
    checks?: PullRequestCheck[]
    landingState?: () => { remoteLandingTip: string; mergeBase: string }
    hasCommit?: (cwd: string, headCommit: string) => boolean
    merge?: (method: string, subject: string, headCommit: string) => string
    admission?: (
      cwd: string,
      headCommit: string,
      headBranch: string,
      database: ReturnType<typeof db>,
    ) => { change: PullRequestChange; decision: AdmissionDecision }
    recordAdmission?: (
      change: PullRequestChange,
      decision: AdmissionDecision,
      prNumber: number,
      database: ReturnType<typeof db>,
    ) => number | null
    shipCleanup?: () => string
  } = {},
): PullRequestMergeAdapter {
  return {
    view: (_cwd, target) => input.view?.(target) ?? pullRequest,
    checks: () => input.checks ?? [],
    landingState: input.landingState ?? (() => ({ remoteLandingTip: 'base', mergeBase: 'base' })),
    hasCommit: input.hasCommit ?? (() => true),
    admission:
      input.admission ??
      (() => ({
        change: { branch: pullRequest.headBranch } as PullRequestChange,
        decision: {
          complete: true,
          overrideId: null,
          triage: { complete: true, snapshot: {} } as AdmissionDecision['triage'],
        },
      })),
    recordAdmission: (change, decision, prNumber, database) =>
      input.recordAdmission?.(change, decision, prNumber, database) ?? null,
    merge: (_cwd, _number, method, subject, headCommit) =>
      input.merge?.(method, subject, headCommit) ?? 'merge-commit',
    queueState: () => ({
      pullRequestState: 'MERGED',
      mergeCommit: 'merge-commit',
      entryState: null,
    }),
    enqueue: () => {},
    now: Date.now,
    wait: () => {},
    ...(input.shipCleanup ? { shipCleanup: input.shipCleanup } : {}),
  }
}

function recordPassingGate(): void {
  db()
    .query(
      `INSERT INTO gate_execution
        (record_id, requested_at,finished_at,exit_code,timed_out,elapsed_ms,output_tail,head_commit,cwd)
       VALUES ('${newRecordId()}', '2026-10-09','2026-10-09',0,0,100,'passed',?,?)`,
    )
    .run(pullRequest.headCommit, cwd)
}

test('an injected forge adapter merges all-passing checks with the method, subject, and proven head', () => {
  registerProject(['test'])
  const calls: [string, string, string][] = []
  const commit = mergePullRequest(
    '42',
    cwd,
    adapter({
      checks: [
        {
          name: 'test',
          bucket: 'pass',
          state: 'SUCCESS',
          link: 'https://checks.example/test',
        },
      ],
      merge: (method, subject, headCommit) => {
        calls.push([method, subject, headCommit])
        return 'merged-oid'
      },
    }),
  )
  expect(commit).toBe('merged-oid')
  expect(calls).toEqual([['squash', 'Prove the pull request head (#42)', 'head-commit']])
})

test('a cleanup failure reports its retry without undoing a successful merge', () => {
  registerProject(['test'])
  const output = mergePullRequest(
    '42',
    cwd,
    adapter({
      checks: [{ name: 'test', bucket: 'pass', state: 'SUCCESS', link: '' }],
      shipCleanup: () => {
        throw new Error('close-out unavailable')
      },
    }),
  )
  expect(output).toBe(
    `merge-commit\nship cleanup failed for ${pullRequest.headBranch}: close-out unavailable; retry: ${PLATFORM_SLUG} tree ship-cleanup ${pullRequest.headBranch}`,
  )
})

test('an injected forge adapter exposes a pending required check without merging', () => {
  registerProject(['test'])
  let merged = false
  expect(() =>
    mergePullRequest(
      '42',
      cwd,
      adapter({
        checks: [
          {
            name: 'test',
            bucket: 'pending',
            state: 'IN_PROGRESS',
            link: 'https://checks.example/test',
          },
        ],
        merge: () => {
          merged = true
          return 'unexpected'
        },
      }),
    ),
  ).toThrow('test: IN_PROGRESS (https://checks.example/test)')
  expect(merged).toBe(false)
})

test('an incomplete admission refuses with its review remedy without merging', () => {
  registerProject([])
  recordPassingGate()
  let merged = false
  expect(() =>
    mergePullRequest(
      '42',
      cwd,
      adapter({
        admission: () => ({
          change: {
            branch: pullRequest.headBranch,
            tip: pullRequest.headCommit,
            group: { patchId: 'patch' },
            tier: 2,
          } as PullRequestChange,
          decision: {
            complete: false,
            overrideId: null,
            triage: {
              complete: false,
              snapshot: {
                reviewIds: [],
                patchId: 'patch',
                tier: 2,
                lensRounds: 0,
                findingCount: 0,
                admissionPath: 'exact_review',
                readId: null,
              },
              missingReview: true,
              unfinishedReviewIds: [],
              undisposedFindings: [],
              missingLenses: [],
              missingSecondOpinion: null,
              finalTierRaised: false,
              architectReadRequired: false,
              earlierReviewId: null,
              earlierReviewTier: null,
            },
          },
        }),
        merge: () => {
          merged = true
          return 'unexpected'
        },
      }),
    ),
  ).toThrow('missing review for patch patch; cleared by: run and record the tier 2 review')
  expect(merged).toBe(false)
})

test('an admission lookup that cannot see the head refuses with the fetch command', () => {
  registerProject(['test'])
  let merged = false
  expect(() =>
    mergePullRequest(
      '42',
      cwd,
      adapter({
        hasCommit: () => false,
        admission: () => {
          throw new Error('git rev-parse --verify head-commit failed')
        },
        merge: () => {
          merged = true
          return 'unexpected'
        },
      }),
    ),
  ).toThrow(`git fetch origin pull/42/head, then ${PLATFORM_SLUG} pr merge 42`)
  expect(merged).toBe(false)
})

test('an admission error for a present head uses the general proof refusal', () => {
  registerProject(['test'])
  let failure = ''
  try {
    mergePullRequest(
      '42',
      cwd,
      adapter({
        admission: () => {
          throw new Error('review store unavailable')
        },
      }),
    )
  } catch (cause) {
    failure = cause instanceof Error ? cause.message : String(cause)
  }
  expect(failure).toContain(
    `proof was not checked: review store unavailable; cleared by: restore forge and repository access, then ${PLATFORM_SLUG} pr merge 42`,
  )
  expect(failure).not.toContain('git fetch origin pull/42/head')
})

test('an admitted head records a snapshot with the pull request number before merging', () => {
  registerProject(['test'])
  const database = db()
  const project = database
    .query<{ record_id: string }, [string]>('SELECT record_id FROM project WHERE name=?')
    .get('merge-fixture')!
  const decision: AdmissionDecision = {
    complete: true,
    overrideId: null,
    triage: {
      complete: true,
      snapshot: {
        reviewIds: [],
        patchId: 'patch',
        tier: 2,
        lensRounds: 0,
        findingCount: 0,
        admissionPath: 'exact_review',
        readId: null,
      },
    },
  }
  mergePullRequest(
    '42',
    cwd,
    adapter({
      checks: [
        {
          name: 'test',
          bucket: 'pass',
          state: 'SUCCESS',
          link: 'https://checks.example/test',
        },
      ],
      admission: (admissionCwd, headCommit, headBranch, admittedDatabase) => {
        expect(admissionCwd).toBe(cwd)
        expect(admittedDatabase).toBe(database)
        return {
          change: {
            project: {
              recordId: project.record_id,
              name: 'merge-fixture',
              path: admissionCwd,
              stack: 'bun',
              canon: false,
              retiredAt: null,
              settings: {},
            },
            branch: headBranch,
            tip: headCommit,
            tree: 'head-tree',
            group: {
              project: 'merge-fixture',
              branch: headBranch,
              patchId: 'patch',
              pathSet: ['orchestrator/src/pull-request/pr-merge.ts'],
            },
            tier: 2 as const,
          },
          decision,
        }
      },
      recordAdmission: (admittedChange, admittedDecision, number, admittedDatabase) =>
        recordMergeAdmission(admittedChange, admittedDecision, number, admittedDatabase),
    }),
    database,
  )
  expect(
    database
      .query(
        `SELECT pr_number,override_id FROM landing_triage_snapshot
          WHERE project=? AND branch=? AND tip=?`,
      )
      .get('merge-fixture', pullRequest.headBranch, pullRequest.headCommit),
  ).toEqual({ pr_number: 42, override_id: null })
})

test('a failing forge call refuses because proof was not checked', () => {
  registerProject(['test'])
  expect(() =>
    mergePullRequest(
      'https://github.com/example/repo/pull/42',
      cwd,
      adapter({
        view: () => {
          throw new Error('forge unavailable')
        },
      }),
    ),
  ).toThrow('proof was not checked: forge unavailable')
})

test('a head commit that changes after checks is refused without merging', () => {
  registerProject(['test'])
  let views = 0
  let merged = false
  expect(() =>
    mergePullRequest(
      '42',
      cwd,
      adapter({
        view: () => ({
          ...pullRequest,
          headCommit: views++ === 0 ? 'head-commit' : 'changed-head-commit',
        }),
        checks: [
          {
            name: 'test',
            bucket: 'pass',
            state: 'SUCCESS',
            link: 'https://checks.example/test',
          },
        ],
        merge: () => {
          merged = true
          return 'unexpected'
        },
      }),
    ),
  ).toThrow('head changed from head-commit to changed-head-commit')
  expect(merged).toBe(false)
})

test('a missing recorded local gate refuses with the gate command', () => {
  registerProject([])
  expect(() => mergePullRequest('42', cwd, adapter())).toThrow(`run ${PLATFORM_SLUG} gate run`)
})

test('a moved landing branch refuses after reading the recorded local gate', () => {
  registerProject([])
  recordPassingGate()
  expect(() =>
    mergePullRequest(
      '42',
      cwd,
      adapter({
        landingState: () => ({ remoteLandingTip: 'new-base', mergeBase: 'old-base' }),
      }),
    ),
  ).toThrow(`bring the branch up to origin/main, run ${PLATFORM_SLUG} gate run`)
})
