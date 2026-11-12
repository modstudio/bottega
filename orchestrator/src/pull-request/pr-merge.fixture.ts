import { fileURLToPath } from 'node:url'
import { db } from '../database/db.ts'
import { projectByName } from '../project/projects.ts'
import type { RequiredReleaseReport } from '../release/release-required.ts'
import type { ShipCleanupReport } from '../ship-cleanup/ship-cleanup.ts'
import type { AdmissionDecision } from './admission-decision.ts'
import type { PullRequestCheck } from './merge-decision.ts'
import type { PullRequestChange } from './pr-admission.ts'
import type { PullRequestMergeAdapter, PullRequestMergeFacts } from './pr-merge.ts'
import {
  mergeCleanupReport,
  recordPassingMergeGate,
  registerMergeProject,
} from './pr-merge-required-release.fixture.ts'
import { inProcessPostLandingAdapter } from './pr-post-landing.fixture.ts'
import type { WorkflowPromotionResult } from './pr-post-landing.ts'

export const cwd = fileURLToPath(new URL('../../..', import.meta.url)).replace(/\/$/, '')

export const pullRequest: PullRequestMergeFacts = {
  nodeId: 'PR_node_id',
  number: 42,
  url: 'https://github.example/pulls/42',
  headCommit: 'head-commit',
  headBranch: 'DEV-1255-admission',
  baseBranch: 'main',
  title: 'Prove the pull request head',
  state: 'OPEN',
  mergeStateStatus: 'CLEAN',
  mergeCommit: null,
}

export const registerProject = (requiredChecks: string[], mergeQueue = false) =>
  registerMergeProject(cwd, requiredChecks, mergeQueue)

export const cleanupReport = (overrides?: Partial<Pick<ShipCleanupReport, 'kept' | 'errors'>>) =>
  mergeCleanupReport(cwd, pullRequest.headBranch, overrides)

export const recordPassingGate = () => recordPassingMergeGate(pullRequest.headCommit, cwd)

export function adapter(
  input: {
    view?: (target: string) => PullRequestMergeFacts
    checks?: PullRequestCheck[] | (() => PullRequestCheck[])
    landingState?: () => { remoteLandingTip: string; mergeBase: string }
    hasCommit?: (cwd: string, headCommit: string) => boolean
    merge?: (method: string, subject: string, headCommit: string) => string
    mergeCommit?: () => string
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
    postMergeChange?: () => PullRequestChange
    recordLandings?: () => void
    moveMain?: () => void
    promoteMergedWorkflowDrafts?: () => string | WorkflowPromotionResult
    recordCi?: () => string | undefined
    shipCleanup?: () => ShipCleanupReport
    queueState?: () => ReturnType<PullRequestMergeAdapter['queueState']>
    wait?: () => void
    releaseRequired?: (enabled: boolean) => RequiredReleaseReport
  } = {},
): PullRequestMergeAdapter {
  let mergedCommit = 'merge-commit'
  const pathSet = input.promoteMergedWorkflowDrafts
    ? ['.agents/workflows/fixture.md']
    : ['orchestrator/src/pull-request/pr-merge.ts']
  return {
    repository: () => 'example/repository',
    view: (_cwd, target) => input.view?.(target) ?? pullRequest,
    checks: () => (typeof input.checks === 'function' ? input.checks() : (input.checks ?? [])),
    landingState: input.landingState ?? (() => ({ remoteLandingTip: 'base', mergeBase: 'base' })),
    hasCommit: input.hasCommit ?? (() => true),
    admission:
      input.admission ??
      (() => ({
        change: {
          branch: pullRequest.headBranch,
          group: { pathSet },
        } as PullRequestChange,
        decision: {
          complete: true,
          overrideId: null,
          triage: { complete: true, snapshot: {} } as AdmissionDecision['triage'],
        },
      })),
    recordAdmission: (change, decision, prNumber, database) =>
      input.recordAdmission?.(change, decision, prNumber, database) ?? null,
    postMergeChange:
      input.postMergeChange ??
      (() =>
        ({
          project: { name: 'merge-fixture', path: cwd },
          branch: pullRequest.headBranch,
          group: { pathSet },
        }) as PullRequestChange),
    ...(input.recordLandings ? { recordLandings: input.recordLandings } : {}),
    ...(input.recordCi ? { recordCi: input.recordCi } : {}),
    merge: (_cwd, _number, method, subject, headCommit) => {
      mergedCommit = input.merge?.(method, subject, headCommit) ?? 'merge-commit'
    },
    mergeCommit: () => input.mergeCommit?.() ?? mergedCommit,
    queueState:
      input.queueState ??
      (() => ({
        pullRequestState: 'MERGED',
        mergeCommit: 'merge-commit',
        entryState: null,
        enqueuedAt: null,
      })),
    enqueue: () => {},
    requeue: () => {},
    failedMergeGroupRun: () => null,
    now: Date.now,
    wait: () => input.wait?.(),
    ...(input.shipCleanup ? { shipCleanup: input.shipCleanup } : {}),
    postLanding: inProcessPostLandingAdapter({
      database: db(),
      project: () => projectByName('merge-fixture')!,
      move: input.moveMain,
      promote: input.promoteMergedWorkflowDrafts,
      release: (enabled) =>
        input.releaseRequired?.(enabled) ?? { required: [], releases: [], satisfied: true },
      cleanup: () => input.shipCleanup?.() ?? cleanupReport(),
    }),
  }
}
