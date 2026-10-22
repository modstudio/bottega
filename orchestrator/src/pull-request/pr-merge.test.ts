import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { db } from '../database/db.ts'
import type { ShipCleanupReport } from '../ship-cleanup/ship-cleanup.ts'
import { decideShipCleanupVerdict } from '../ship-cleanup/ship-cleanup-decision.ts'
import type { AdmissionDecision } from './admission-decision.ts'
import type { PullRequestCheck } from './merge-decision.ts'
import { type PullRequestChange, recordMergeAdmission } from './pr-admission.ts'
import {
  MERGED_WITH_RESIDUE_EXIT_CODE,
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
    ) => string | null
    recordLandings?: () => void
    shipCleanup?: () => ShipCleanupReport
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
    ...(input.recordLandings ? { recordLandings: input.recordLandings } : {}),
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

const cleanupReport = (
  overrides: Partial<Pick<ShipCleanupReport, 'kept' | 'errors'>> = {},
): ShipCleanupReport => ({
  project: 'merge-fixture',
  branch: pullRequest.headBranch,
  freed: { artifacts: 0, scratch: 0, worktrees: 0 },
  removed: { artifacts: [], scratch: [], worktrees: [], branches: [] },
  reclaimed: { processes: [], compose: [] },
  gone: [],
  kept: overrides.kept ?? [],
  errors: overrides.errors ?? [],
  verdict: decideShipCleanupVerdict({
    kept: overrides.kept ?? [],
    errors: overrides.errors ?? [],
  }),
})

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
  expect(commit.output).toBe('merged-oid')
  expect(calls).toEqual([['squash', 'Prove the pull request head (#42)', 'head-commit']])
})

test('a cleanup failure reports its retry without undoing a successful merge', () => {
  registerProject(['test'])
  const outcome = mergePullRequest(
    '42',
    cwd,
    adapter({
      checks: [{ name: 'test', bucket: 'pass', state: 'SUCCESS', link: '' }],
      shipCleanup: () => {
        throw new Error('close-out unavailable')
      },
    }),
  )
  expect(outcome.output).toBe(
    `merge-commit\nship cleanup failed for ${pullRequest.headBranch}: close-out unavailable; retry: ${PLATFORM_SLUG} tree ship-cleanup ${pullRequest.headBranch}`,
  )
  expect(outcome.exitCode).toBe(MERGED_WITH_RESIDUE_EXIT_CODE)
})

test('a merge reports residue when cleanup keeps anything beyond its command tree', () => {
  registerProject(['test'])
  const outcome = mergePullRequest(
    '42',
    cwd,
    adapter({
      checks: [{ name: 'test', bucket: 'pass', state: 'SUCCESS', link: '' }],
      shipCleanup: () =>
        cleanupReport({
          kept: [
            {
              item: 'branch DEV-1-a',
              reason: 'live',
              reasonKind: 'safety-hold',
              owner: 'other',
            },
          ],
        }),
    }),
  )
  expect(outcome.exitCode).toBe(MERGED_WITH_RESIDUE_EXIT_CODE)
  expect(outcome.output.startsWith('merge-commit\n')).toBe(true)
})

test('a merge succeeds when cleanup keeps only the caller landing tree and branch', () => {
  registerProject(['test'])
  const kept = [
    {
      item: 'run 7 worktree',
      reason: 'the command runs from this tree',
      reasonKind: 'command-tree' as const,
      owner: 'caller-landing-tree' as const,
    },
    {
      item: `branch ${pullRequest.headBranch}`,
      reason: 'checked-out',
      reasonKind: 'safety-hold' as const,
      owner: 'caller-landing-tree' as const,
    },
  ]
  const outcome = mergePullRequest(
    '42',
    cwd,
    adapter({
      checks: [{ name: 'test', bucket: 'pass', state: 'SUCCESS', link: '' }],
      shipCleanup: () => cleanupReport({ kept }),
    }),
  )
  expect(outcome.exitCode).toBe(0)
  expect(outcome.output).toContain('information: kept run 7 worktree')
  expect(outcome.output).toContain(`information: kept branch ${pullRequest.headBranch}`)
  expect(outcome.output).toContain('kept: none')
})

test('a merge with mixed cleanup holds names only foreign items as residue', () => {
  registerProject(['test'])
  const outcome = mergePullRequest(
    '42',
    cwd,
    adapter({
      checks: [{ name: 'test', bucket: 'pass', state: 'SUCCESS', link: '' }],
      shipCleanup: () =>
        cleanupReport({
          kept: [
            {
              item: 'run 7 worktree',
              reason: 'the command runs from this tree',
              reasonKind: 'command-tree',
              owner: 'caller-landing-tree',
            },
            {
              item: 'run 8 worktree',
              reason: 'held by another session',
              reasonKind: 'safety-hold',
              owner: 'other',
            },
          ],
        }),
    }),
  )
  expect(outcome.exitCode).toBe(MERGED_WITH_RESIDUE_EXIT_CODE)
  expect(outcome.output).toContain('information: kept run 7 worktree')
  expect(outcome.output).toContain('kept: run 8 worktree: held by another session')
  expect(outcome.output).not.toContain('kept: run 7 worktree')
})

test('a successful merge records contained branches before cleanup can delete them', () => {
  registerProject(['test'])
  const calls: string[] = []
  mergePullRequest(
    '42',
    cwd,
    adapter({
      checks: [{ name: 'test', bucket: 'pass', state: 'SUCCESS', link: '' }],
      merge: () => {
        calls.push('merge')
        return 'merge-commit'
      },
      recordLandings: () => calls.push('record-landings'),
      shipCleanup: () => {
        calls.push('cleanup')
        return cleanupReport()
      },
    }),
  )
  expect(calls).toEqual(['merge', 'record-landings', 'cleanup'])
})

test('a landing-record failure preserves branches by skipping cleanup', () => {
  registerProject(['test'])
  let cleaned = false
  const output = mergePullRequest(
    '42',
    cwd,
    adapter({
      checks: [{ name: 'test', bucket: 'pass', state: 'SUCCESS', link: '' }],
      recordLandings: () => {
        throw new Error('local refs unavailable')
      },
      shipCleanup: () => {
        cleaned = true
        return cleanupReport()
      },
    }),
  )
  expect(output.output).toContain('landing recording failed')
  expect(cleaned).toBe(false)
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
                reviewRecordIds: [],
                patchId: 'patch',
                tier: 2,
                lensRounds: 0,
                findingCount: 0,
                admissionPath: 'exact_review',
                readRecordId: null,
              },
              missingReview: true,
              unfinishedReviewNumbers: [],
              undisposedFindings: [],
              missingLenses: [],
              missingSecondOpinion: null,
              finalTierRaised: false,
              architectReadRequired: false,
              earlierReviewNumber: null,
              earlierReviewTier: null,
              noCompleteReviewRound: true,
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
        reviewRecordIds: [],
        patchId: 'patch',
        tier: 2,
        lensRounds: 0,
        findingCount: 0,
        admissionPath: 'exact_review',
        readRecordId: null,
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
            applicability: { lenses: ['correctness', 'craft'] },
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
        `SELECT pr_number,override_record_id FROM landing_triage_snapshot
          WHERE project=? AND branch=? AND tip=?`,
      )
      .get('merge-fixture', pullRequest.headBranch, pullRequest.headCommit),
  ).toEqual({ pr_number: 42, override_record_id: null })
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
