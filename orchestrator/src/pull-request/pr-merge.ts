// concern: pull-request merge
/**
 * Resolves forge and local proof facts, then performs an admitted merge.
 * The landing branch can still move between its fetch and the merge because the forge cannot condition a merge on the base tip without branch protection.
 */

import type { Database } from 'bun:sqlite'
import { startBoundedSync } from '../../../shared/bounded-process.ts'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { BoundExceededError, budgetForArgv } from '../../../shared/call-budgets.ts'
import { refusal, renderRefusal } from '../../../shared/refusal.ts'
import { recordMergeBranchLandings } from '../branch/branch-landing-service.ts'
import { enableSchemaReload, writableDb } from '../database/db.ts'
import { passingGateForCommit } from '../gate/gate-passed.ts'
import { runWithGitFetchRetry } from '../git/fetch-retry.ts'
import { targetGitEnvironment } from '../git/git-environment.ts'
import { currentProjectRepository, type Project, projectAt } from '../project/projects.ts'
import { runReleasePreflight } from '../release/release-preflight-adapter.ts'
import type { RequiredRungDecision } from '../release/release-required.ts'
import { shipToDepthRefusal } from '../release/ship-to-reach.ts'
import { type ShipCleanupReport, shipCleanup } from '../ship-cleanup/ship-cleanup.ts'
import { matchWorkflowTreePath } from '../workflow/workflow-tree.ts'
import {
  decideMergeAdmission,
  decideMergeProof,
  decidePullRequestIdentity,
  type MergeDecision,
  type MergeProofInput,
  type PullRequestCheck,
} from './merge-decision.ts'
import type { FailedMergeGroupRun } from './merge-group-run.ts'
import { decideMergePolicyRefusal } from './merge-policy-decision.ts'
import {
  type MergeQueueObservation,
  type MergeQueueState,
  type MergeQueueStep,
  mergeQueueEnqueueFailureRemedy,
} from './merge-queue-decision.ts'
import {
  enqueuePullRequest,
  githubFailedMergeGroupRun,
  githubLandingComparison,
  githubMergeQueueState,
  requeuePullRequest,
} from './merge-queue-forge.ts'
import { driveMergeQueueWait } from './merge-queue-wait.ts'
import { decideMergeability, type MergeabilityFacts } from './mergeability-decision.ts'
import {
  type AdmissionWithTriage,
  admissionDecision,
  type EvaluatedAdmission,
  funnelRefusal,
  type PullRequestAdmission,
  type PullRequestChange,
  recordMergeAdmission,
  resolvePullRequestChange,
  triageRefusal,
} from './pr-admission.ts'

import { recordPullRequestCi } from './pr-ci-record.ts'
import {
  type PullRequestMergeFacts,
  recordPostMergeEvidence,
  refuseMergedWithoutCommit,
} from './pr-merge-evidence.ts'
import {
  completePullRequestPostLanding,
  type PullRequestMergeOutcome,
  type PullRequestPostLandingAdapter,
} from './pr-post-landing.ts'
import {
  type PullRequestReleaseDecisionAdapter,
  preparePullRequestRelease,
  pullRequestReleaseDecisionAtHead,
} from './pr-release-admission.ts'
import { assertPullRequestTaskCursorAdmission } from './task-cursor-admission.ts'

export type { PullRequestMergeFacts } from './pr-merge-evidence.ts'
export type PullRequestMergeCommandOutcome = PullRequestMergeOutcome & {
  pullRequestNumber: number
  mergeCommit: string
  headBranch: string
}

export type PullRequestMergeAdapter = PullRequestReleaseDecisionAdapter & {
  repository(project: Project): string | null
  view(cwd: string, target: string): PullRequestMergeFacts
  taskCursorAdmission?(project: Project, branch: string, database: Database): Promise<void>
  releasePreflight?(input: Parameters<typeof runReleasePreflight>[0]): Promise<void>
  checks(cwd: string, number: number): PullRequestCheck[]
  landingState(
    cwd: string,
    headCommit: string,
    landingBranch: string,
  ): { remoteLandingTip: string; mergeBase: string }
  hasCommit(cwd: string, headCommit: string): boolean
  admission(
    cwd: string,
    headCommit: string,
    headBranch: string,
    database: Database,
  ):
    | Promise<{ change: PullRequestChange; decision: PullRequestAdmission }>
    | {
        change: PullRequestChange
        decision: PullRequestAdmission
      }
  recordAdmission(
    change: PullRequestChange,
    decision: AdmissionWithTriage,
    prNumber: number,
    database: Database,
  ): string | null
  postMergeChange(
    cwd: string,
    headCommit: string,
    headBranch: string,
    database: Database,
  ): PullRequestChange
  recordLandings?(
    change: PullRequestChange,
    pullRequest: PullRequestMergeFacts,
    database: Database,
  ): void
  recordCi?(
    change: PullRequestChange,
    pullRequest: PullRequestMergeFacts,
    database: Database,
  ): string | undefined
  merge(
    cwd: string,
    number: number,
    method: 'squash' | 'merge' | 'rebase',
    subject: string,
    headCommit: string,
  ): void
  mergeCommit(cwd: string, number: number): string
  queueState(cwd: string, nodeId: string): MergeQueueObservation
  landingComparison(
    cwd: string,
    repository: string,
    landingBranch: string,
    mergeCommit: string,
  ): string
  enqueue(cwd: string, number: number, headCommit: string): void
  requeue(cwd: string, nodeId: string, headCommit: string): void
  failedMergeGroupRun(
    cwd: string,
    repository: string,
    baseBranch: string,
    pullRequestNumber: number,
    enqueuedAt: string,
  ): FailedMergeGroupRun | null
  now(): number
  wait(milliseconds: number): void
  shipCleanup?(
    project: string,
    branch: string,
    prNumber: number,
    database: Database,
  ): Promise<ShipCleanupReport> | ShipCleanupReport
  postLanding?: PullRequestPostLandingAdapter
}

type ProcessResult = { exitCode: number; stdout: string; stderr: string }

function run(cwd: string, argv: string[]): ProcessResult {
  const result = startBoundedSync(argv, {
    budget: budgetForArgv(argv),
    cwd,
    env: targetGitEnvironment(cwd),
  })
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  }
}

function successful(cwd: string, argv: string[], label: string): string {
  const result = runWithGitFetchRetry(argv, () => {
    const attempt = run(cwd, argv)
    return {
      result: attempt,
      succeeded: attempt.exitCode === 0,
      stderr: attempt.stderr || `exit ${attempt.exitCode}`,
    }
  })
  if (result.exitCode !== 0) {
    throw new Error(`${label} failed: ${result.stderr || `exit ${result.exitCode}`}`)
  }
  return result.stdout
}

function parsed<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T
  } catch (cause) {
    throw new Error(
      `${label} returned invalid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
  }
}

const cliPullRequestMergeAdapter: PullRequestMergeAdapter = {
  repository(project) {
    return currentProjectRepository(project)
  },
  view(cwd, target) {
    const value = parsed<{
      id?: unknown
      number?: unknown
      url?: unknown
      headRefOid?: unknown
      headRefName?: unknown
      baseRefName?: unknown
      title?: unknown
      state?: unknown
      mergeStateStatus?: unknown
      mergeCommit?: { oid?: unknown } | null
    }>(
      successful(
        cwd,
        [
          'gh',
          'pr',
          'view',
          target,
          '--json',
          'id,number,url,headRefOid,headRefName,baseRefName,title,state,mergeStateStatus,mergeCommit',
        ],
        'pull-request lookup',
      ),
      'pull-request lookup',
    )
    if (
      typeof value.id !== 'string' ||
      !Number.isSafeInteger(value.number) ||
      typeof value.url !== 'string' ||
      typeof value.headRefOid !== 'string' ||
      typeof value.headRefName !== 'string' ||
      typeof value.baseRefName !== 'string' ||
      typeof value.title !== 'string' ||
      typeof value.state !== 'string' ||
      typeof value.mergeStateStatus !== 'string'
    ) {
      throw new Error('pull-request lookup returned an unexpected JSON shape')
    }
    return {
      nodeId: value.id,
      number: Number(value.number),
      url: value.url,
      headCommit: value.headRefOid,
      headBranch: value.headRefName,
      baseBranch: value.baseRefName,
      title: value.title,
      state: value.state,
      mergeStateStatus: value.mergeStateStatus,
      mergeCommit: typeof value.mergeCommit?.oid === 'string' ? value.mergeCommit.oid : null,
    }
  },
  async taskCursorAdmission(project, branch, database) {
    await assertPullRequestTaskCursorAdmission({
      command: 'pr merge',
      project,
      branch,
      database,
      checkoutRoots: [],
    })
  },
  releasePreflight: runReleasePreflight,
  releaseDecision: pullRequestReleaseDecisionAtHead,
  checks(cwd, number) {
    const result = run(cwd, [
      'gh',
      'pr',
      'checks',
      String(number),
      '--json',
      'name,bucket,state,link',
    ])
    if (![0, 1, 8].includes(result.exitCode)) {
      throw new Error(
        `pull-request check lookup failed: ${result.stderr || `exit ${result.exitCode}`}`,
      )
    }
    const values = parsed<unknown>(result.stdout, 'pull-request check lookup')
    if (!Array.isArray(values)) {
      throw new Error('pull-request check lookup returned an unexpected JSON shape')
    }
    return values.map((value) => {
      if (
        typeof value !== 'object' ||
        value === null ||
        typeof value.name !== 'string' ||
        !['pass', 'fail', 'pending', 'skipping', 'cancel'].includes(String(value.bucket)) ||
        typeof value.state !== 'string' ||
        typeof value.link !== 'string'
      ) {
        throw new Error('pull-request check lookup returned an unexpected JSON shape')
      }
      return value as PullRequestCheck
    })
  },
  landingState(cwd, headCommit, landingBranch) {
    successful(cwd, ['git', 'fetch', 'origin', landingBranch], 'remote landing-branch fetch')
    const remote = `refs/remotes/origin/${landingBranch}`
    return {
      remoteLandingTip: successful(
        cwd,
        ['git', 'rev-parse', '--verify', `${remote}^{commit}`],
        'remote landing-branch lookup',
      ),
      mergeBase: successful(
        cwd,
        ['git', 'merge-base', headCommit, remote],
        'landing merge-base lookup',
      ),
    }
  },
  hasCommit(cwd, headCommit) {
    return run(cwd, ['git', 'cat-file', '-e', `${headCommit}^{commit}`]).exitCode === 0
  },
  async admission(cwd, headCommit, headBranch, database) {
    const change = resolvePullRequestChange(cwd, headCommit, database, undefined, headBranch)
    const evaluated = await admissionDecision(change, database)
    return { change, decision: evaluated }
  },
  recordAdmission(change, decision, prNumber, database) {
    return recordMergeAdmission(change, decision, prNumber, database)
  },
  postMergeChange(cwd, headCommit, headBranch, database) {
    return resolvePullRequestChange(cwd, headCommit, database, undefined, headBranch)
  },
  recordLandings(change, pullRequest) {
    recordMergeBranchLandings({
      project: change.project,
      taskBranch: pullRequest.headBranch,
      admittedHead: pullRequest.headCommit,
      number: pullRequest.number,
    })
  },
  recordCi(change, pullRequest, database) {
    const result = recordPullRequestCi({
      project: change.project,
      target: String(pullRequest.number),
      cwd: change.project.path,
      database,
    })
    return result.complete ? undefined : result.error
  },
  merge(cwd, number, method, subject, headCommit) {
    successful(
      cwd,
      [
        'gh',
        'pr',
        'merge',
        String(number),
        `--${method}`,
        '--subject',
        subject,
        '--match-head-commit',
        headCommit,
      ],
      'pull-request merge',
    )
  },
  mergeCommit(cwd, number) {
    const value = parsed<{ mergeCommit?: { oid?: unknown } | null }>(
      successful(
        cwd,
        ['gh', 'pr', 'view', String(number), '--json', 'mergeCommit'],
        'merge-commit lookup',
      ),
      'merge-commit lookup',
    )
    if (typeof value.mergeCommit?.oid !== 'string') {
      throw new Error('merge-commit lookup returned no merge commit')
    }
    return value.mergeCommit.oid
  },
  queueState(cwd, nodeId) {
    return githubMergeQueueState(cwd, nodeId)
  },
  landingComparison(cwd, repository, landingBranch, mergeCommit) {
    return githubLandingComparison(cwd, repository, landingBranch, mergeCommit)
  },
  enqueue(cwd, number, headCommit) {
    enqueuePullRequest(cwd, number, headCommit)
  },
  requeue(cwd, nodeId, headCommit) {
    requeuePullRequest(cwd, nodeId, headCommit)
  },
  failedMergeGroupRun(cwd, repository, baseBranch, pullRequestNumber, enqueuedAt) {
    return githubFailedMergeGroupRun(cwd, repository, baseBranch, pullRequestNumber, enqueuedAt)
  },
  now: Date.now,
  wait(milliseconds) {
    Bun.sleepSync(milliseconds)
  },
  shipCleanup(project, branch, _prNumber, database) {
    return shipCleanup(branch, { project, confirmedLanded: true, database })
  },
}

export function cliPullRequestMergeAdapterWithPostLanding(
  postLanding: PullRequestPostLandingAdapter,
): PullRequestMergeAdapter {
  return { ...cliPullRequestMergeAdapter, postLanding }
}

function mergedChangeNeedsWorkflowPromotion(paths: readonly string[]): boolean {
  return paths.some((path) => matchWorkflowTreePath(path) !== null)
}

function collectMergeProof(
  pullRequest: PullRequestMergeFacts,
  landingBranch: string,
  requiredChecks: readonly string[],
  mergeQueue: boolean,
  cwd: string,
  adapter: PullRequestMergeAdapter,
  database: Database,
): MergeProofInput {
  if (requiredChecks.length > 0) {
    const checks = adapter.checks(cwd, pullRequest.number)
    const currentHeadCommit = adapter.view(cwd, String(pullRequest.number)).headCommit
    return {
      kind: 'required-checks',
      number: pullRequest.number,
      headCommit: pullRequest.headCommit,
      currentHeadCommit,
      requiredChecks,
      checks,
    }
  }
  const passingGateNumber = passingGateForCommit(pullRequest.headCommit, cwd, database).gateNumber
  if (passingGateNumber === null) {
    const currentHeadCommit = adapter.view(cwd, String(pullRequest.number)).headCommit
    return {
      kind: 'local-gate',
      number: pullRequest.number,
      headCommit: pullRequest.headCommit,
      currentHeadCommit,
      landingBranch,
      mergeQueue,
      gate: { recorded: false },
    }
  }
  const landingState = mergeQueue
    ? { remoteLandingTip: '', mergeBase: '' }
    : adapter.landingState(cwd, pullRequest.headCommit, landingBranch)
  const currentHeadCommit = adapter.view(cwd, String(pullRequest.number)).headCommit
  return {
    kind: 'local-gate',
    number: pullRequest.number,
    headCommit: pullRequest.headCommit,
    currentHeadCommit,
    landingBranch,
    mergeQueue,
    gate: {
      recorded: true,
      ...landingState,
    },
  }
}

function readCheckRollup(
  adapter: PullRequestMergeAdapter,
  cwd: string,
  number: number | undefined,
): PullRequestCheck[] | null {
  if (number === undefined) return null
  try {
    return adapter.checks(cwd, number)
  } catch (cause) {
    if (cause instanceof BoundExceededError) throw cause
    return null
  }
}

type MergeErrorContext = {
  cwd: string
  target: string
  number: number | undefined
  adapter: PullRequestMergeAdapter
}

function throwMergeOperationError(
  cause: unknown,
  input: MergeErrorContext & { fallback: (message: string) => Error },
): never {
  if (cause instanceof BoundExceededError) throw cause
  const message = cause instanceof Error ? cause.message : String(cause)
  const decision = decideMergePolicyRefusal({
    message,
    checks: readCheckRollup(input.adapter, input.cwd, input.number),
    target: input.target,
    number: input.number ?? null,
  })
  if (decision.policy) throw new Error(`refusing merge: ${decision.refusal}`)
  throw input.fallback(message)
}

function refuseUncaughtMergeError(cause: unknown, input: MergeErrorContext): never {
  const message = cause instanceof Error ? cause.message : String(cause)
  if (message.startsWith('refusing merge:')) throw cause
  throwMergeOperationError(cause, {
    ...input,
    fallback: (error) =>
      new Error(
        `refusing merge because the pull request proof was not checked: ${error}; cleared by: restore forge and repository access, then ${PLATFORM_SLUG} pr merge ${input.target}`,
      ),
  })
}

function mergeAdmittedHead(input: {
  pullRequest: PullRequestMergeFacts
  project: Project
  mergeQueue: boolean
  mergeMethod: 'squash' | 'merge' | 'rebase'
  cwd: string
  adapter: PullRequestMergeAdapter
  target: string
}): { mergeCommit?: string; mergeCommitLookupError?: unknown; requeueOutput?: string } {
  if (input.mergeQueue) {
    return waitForQueuedMerge(
      input.pullRequest,
      input.cwd,
      input.adapter.repository(input.project),
      input.adapter,
      input.target,
    )
  }
  input.adapter.merge(
    input.cwd,
    input.pullRequest.number,
    input.mergeMethod,
    `${input.pullRequest.title} (#${input.pullRequest.number})`,
    input.pullRequest.headCommit,
  )
  try {
    return { mergeCommit: input.adapter.mergeCommit(input.cwd, input.pullRequest.number) }
  } catch (mergeCommitLookupError) {
    return { mergeCommitLookupError }
  }
}

function waitForQueuedMerge(
  pullRequest: PullRequestMergeFacts,
  cwd: string,
  repository: string | null,
  adapter: PullRequestMergeAdapter,
  target: string,
): { mergeCommit: string; requeueOutput?: string } {
  return driveMergeQueueWait({
    pullRequest,
    cwd,
    repository,
    target,
    adapter,
    refuse: (action, state, enqueuedAt) =>
      throwMergeQueueRefusal(action, state, pullRequest, cwd, repository, enqueuedAt, adapter),
    enqueue: () => enqueueForMergeQueue(pullRequest, cwd, adapter, target),
    requeue: (enqueuedAt) => {
      const evidence = failedMergeGroupRun(
        pullRequest,
        cwd,
        repository,
        enqueuedAt,
        adapter,
      ).evidence
      requeueForMergeQueue(pullRequest, cwd, adapter, evidence, target)
      return `requeued #${pullRequest.number} at ${pullRequest.headCommit} after ${evidence}`
    },
  })
}

function throwMergeQueueRefusal(
  action: Extract<MergeQueueStep['action'], { action: 'refuse' }>,
  state: MergeQueueState,
  pullRequest: PullRequestMergeFacts,
  cwd: string,
  repository: string | null,
  enqueuedAt: string | null,
  adapter: PullRequestMergeAdapter,
): never {
  const failed =
    state.state === 'failed' || state.state === 'dequeued'
      ? failedMergeGroupRun(pullRequest, cwd, repository, enqueuedAt, adapter)
      : null
  if (action.source === 'dequeue-reason') {
    const evidence = failed?.run ? `; ${failed.evidence}` : ''
    throw new Error(
      renderRefusal(
        refusal(`refusing merge: ${action.refusal}${evidence}`, {
          kind: 'edit',
          text: action.remedy,
        }),
      ).replace('\n', '; '),
    )
  }
  if (action.source === 'failed-check') {
    const evidence = failed ? `; ${failed.evidence}` : ''
    throw new Error(
      renderRefusal(
        refusal(`refusing merge: ${action.refusal}${evidence}`, {
          kind: 'edit',
          text: action.remedy,
        }),
      ).replace('\n', '; '),
    )
  }
  if (state.state === 'dequeued' && failed?.run) {
    throw new Error(
      renderRefusal(
        refusal(
          `refusing merge: pull request #${pullRequest.number} failed in the merge queue; ${failed.evidence}`,
          {
            kind: 'edit',
            text: `push a fix if the check failure is real, or re-run ${PLATFORM_SLUG} pr merge ${pullRequest.number} to requeue the unchanged head if it flaked`,
          },
        ),
      ).replace('\n', '; '),
    )
  }
  const evidence = state.state === 'failed' && failed ? `; ${failed.evidence}` : ''
  throw new Error(
    renderRefusal(
      refusal(`refusing merge: ${action.refusal}${evidence}`, {
        kind: 'edit',
        text: action.remedy,
      }),
    ).replace('\n', '; '),
  )
}

function failedMergeGroupRun(
  pullRequest: PullRequestMergeFacts,
  cwd: string,
  repository: string | null,
  enqueuedAt: string | null,
  adapter: PullRequestMergeAdapter,
): { run: FailedMergeGroupRun | null; evidence: string } {
  if (!repository)
    return {
      run: null,
      evidence: 'failed merge-group run could not be read: repository identity is absent',
    }
  if (!enqueuedAt) {
    return {
      run: null,
      evidence: 'failed merge-group run could not be read: the queue entry has no enqueue time',
    }
  }
  try {
    const run = adapter.failedMergeGroupRun(
      cwd,
      repository,
      pullRequest.baseBranch,
      pullRequest.number,
      enqueuedAt,
    )
    return {
      run,
      evidence: run
        ? `${run.conclusion} merge-group run ${run.id} (${run.url})`
        : `no merge-group run that failed since ${enqueuedAt} was found`,
    }
  } catch (cause) {
    if (cause instanceof BoundExceededError) throw cause
    return {
      run: null,
      evidence: `failed merge-group run could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
    }
  }
}

function requeueForMergeQueue(
  pullRequest: PullRequestMergeFacts,
  cwd: string,
  adapter: PullRequestMergeAdapter,
  evidence: string,
  target: string,
): void {
  try {
    adapter.requeue(cwd, pullRequest.nodeId, pullRequest.headCommit)
  } catch (cause) {
    throwMergeOperationError(cause, {
      cwd,
      target,
      number: pullRequest.number,
      adapter,
      fallback: (message) =>
        new Error(
          `refusing merge: pull request #${pullRequest.number} could not be requeued after ${evidence}: ${message}; cleared by: ${mergeQueueEnqueueFailureRemedy(pullRequest.number, message)}`,
        ),
    })
  }
}

function enqueueForMergeQueue(
  pullRequest: PullRequestMergeFacts,
  cwd: string,
  adapter: PullRequestMergeAdapter,
  target: string,
): void {
  try {
    adapter.enqueue(cwd, pullRequest.number, pullRequest.headCommit)
  } catch (cause) {
    throwMergeOperationError(cause, {
      cwd,
      target,
      number: pullRequest.number,
      adapter,
      fallback: (message) =>
        new Error(
          `refusing merge: pull request #${pullRequest.number} could not be added to the merge queue: ${message}; cleared by: ${mergeQueueEnqueueFailureRemedy(pullRequest.number, message)}`,
        ),
    })
  }
}

type CheckedMergeAdmission = { change: PullRequestChange; decision: EvaluatedAdmission }

async function collectMergeAdmission(
  pullRequest: PullRequestMergeFacts,
  cwd: string,
  adapter: PullRequestMergeAdapter,
  database: Database,
): Promise<{ decision: MergeDecision; checked: CheckedMergeAdmission | null }> {
  if (!adapter.hasCommit(cwd, pullRequest.headCommit)) {
    return {
      checked: null,
      decision: decideMergeAdmission({
        checked: false,
        number: pullRequest.number,
        headCommit: pullRequest.headCommit,
        problem: `commit ${pullRequest.headCommit} is absent from the checkout`,
      }),
    }
  }
  const checked = await adapter.admission(
    cwd,
    pullRequest.headCommit,
    pullRequest.headBranch,
    database,
  )
  if (checked.decision.kind === 'empty') {
    throw new Error(
      renderRefusal(
        refusal(`refusing merge: ${checked.decision.condition}`, {
          kind: 'edit',
          text:
            `close pull request ${pullRequest.number}, because its head is already on ` +
            pullRequest.baseBranch,
        }),
      ).replace('\n', '; '),
    )
  }
  const measured = { change: checked.change, decision: checked.decision }
  if (measured.decision.complete) {
    return {
      checked: measured,
      decision: decideMergeAdmission({
        checked: true,
        number: pullRequest.number,
        complete: true,
      }),
    }
  }
  const triage = measured.decision.triage
  return {
    checked: measured,
    decision: decideMergeAdmission({
      checked: true,
      number: pullRequest.number,
      complete: false,
      triageRefusal: triage.complete
        ? funnelRefusal(
            `review funnel requires ${checked.decision.verdict.next.action}`,
            checked.decision.verdict,
          )
        : triageRefusal(checked.change, triage),
    }),
  }
}

function refuseUnlessAdmitted(decision: MergeDecision): void {
  if (!decision.admitted) throw new Error(`refusing merge: ${decision.refusal}`)
}

async function admitViewedPullRequest(
  pullRequest: PullRequestMergeFacts,
  input: {
    cwd: string
    adapter: PullRequestMergeAdapter
    database: Database
    landingBranch: string
    requiredChecks: readonly string[]
    mergeQueue: boolean
  },
): Promise<PullRequestChange> {
  const mergeabilityFacts: MergeabilityFacts = {
    mergeStateStatus: pullRequest.mergeStateStatus,
    url: pullRequest.url,
    landingBranch: input.landingBranch,
    boundReached: true,
  }
  const mergeability = decideMergeability(mergeabilityFacts)
  if (mergeability.kind === 'report' && mergeability.conflict) {
    throw new Error(`refusing merge: ${mergeability.message}`)
  }
  refuseUnlessAdmitted(
    decidePullRequestIdentity({
      number: pullRequest.number,
      state: pullRequest.state,
      baseBranch: pullRequest.baseBranch,
      landingBranch: input.landingBranch,
    }),
  )
  const admission = await collectMergeAdmission(
    pullRequest,
    input.cwd,
    input.adapter,
    input.database,
  )
  refuseUnlessAdmitted(admission.decision)
  refuseUnlessAdmitted(
    decideMergeProof(
      collectMergeProof(
        pullRequest,
        input.landingBranch,
        input.requiredChecks,
        input.mergeQueue,
        input.cwd,
        input.adapter,
        input.database,
      ),
    ),
  )
  input.adapter.recordAdmission(
    admission.checked!.change,
    admission.checked!.decision,
    pullRequest.number,
    input.database,
  )
  return admission.checked!.change
}

async function completeMerge(input: {
  target: string
  cwd: string
  adapter: PullRequestMergeAdapter
  database: Database
  project: Project
  landingBranch: string
  requiredChecks: readonly string[]
  mergeQueue: boolean
  mergeMethod: 'squash' | 'merge' | 'rebase'
  releaseRequired: boolean
  depth?: string
}): Promise<PullRequestMergeCommandOutcome> {
  let pullRequest: PullRequestMergeFacts | undefined
  let mergeCommit = ''
  let mergeCommitLookupError: unknown
  let mergeCommitLookupFailed = false
  let requeueOutput: string | undefined
  let admittedChange: PullRequestChange
  let preMergeReleaseDecision: RequiredRungDecision | undefined
  try {
    pullRequest = input.adapter.view(input.cwd, input.target)
  } catch (cause) {
    refuseUncaughtMergeError(cause, {
      cwd: input.cwd,
      target: input.target,
      number: pullRequest?.number,
      adapter: input.adapter,
    })
  }
  await input.adapter.taskCursorAdmission?.(input.project, pullRequest.headBranch, input.database)
  try {
    if (pullRequest.state === 'MERGED') {
      if (!pullRequest.mergeCommit)
        throw new Error('merged pull request lookup returned no merge commit')
      mergeCommit = pullRequest.mergeCommit
      admittedChange = input.adapter.postMergeChange(
        input.cwd,
        pullRequest.headCommit,
        pullRequest.headBranch,
        input.database,
      )
    } else {
      admittedChange = await admitViewedPullRequest(pullRequest, input)
      preMergeReleaseDecision = await preparePullRequestRelease({
        ...input,
        pullRequest,
        changedPaths: admittedChange.group.pathSet,
        releasePreflight: input.adapter.releasePreflight,
      })
      const merged = mergeAdmittedHead({ ...input, pullRequest })
      if (merged.mergeCommit) mergeCommit = merged.mergeCommit
      else {
        mergeCommitLookupFailed = true
        mergeCommitLookupError = merged.mergeCommitLookupError
      }
      requeueOutput = merged.requeueOutput
    }
  } catch (cause) {
    refuseUncaughtMergeError(cause, {
      cwd: input.cwd,
      target: input.target,
      number: pullRequest?.number,
      adapter: input.adapter,
    })
  }
  if (mergeCommitLookupFailed) {
    refuseMergedWithoutCommit({
      adapter: input.adapter,
      change: admittedChange!,
      pullRequest: pullRequest!,
      database: input.database,
      projectName: input.project.name,
      cause: mergeCommitLookupError,
      target: input.target,
    })
  }
  const recordingError = recordPostMergeEvidence({
    adapter: input.adapter,
    change: admittedChange!,
    pullRequest: pullRequest!,
    database: input.database,
    projectName: input.project.name,
  })
  const pathSet = admittedChange!.group?.pathSet
  const workflowPromotionDue = pathSet ? mergedChangeNeedsWorkflowPromotion(pathSet) : true
  const outcome = await completePullRequestPostLanding({
    adapter: {
      ...(input.adapter.shipCleanup ? { cleanup: input.adapter.shipCleanup } : {}),
    },
    postLandingAdapter: input.adapter.postLanding,
    database: input.database,
    project: input.project,
    pullRequest: pullRequest!,
    mergeCommit,
    recordingError,
    requeueOutput,
    target: input.target,
    releaseRequired: input.releaseRequired,
    depth: input.depth,
    workflowPromotionDue,
    preMergeReleaseDecision,
  })
  return {
    ...outcome,
    pullRequestNumber: pullRequest!.number,
    mergeCommit,
    headBranch: pullRequest!.headBranch,
  }
}

export async function mergePullRequest(
  target: string,
  cwd = process.cwd(),
  adapter: PullRequestMergeAdapter = cliPullRequestMergeAdapter,
  injectedDatabase?: Database,
  releaseRequired = false,
  depth?: string,
): Promise<PullRequestMergeCommandOutcome> {
  enableSchemaReload()
  const database = injectedDatabase ?? writableDb()
  const project = projectAt(cwd, database)
  if (!project) {
    throw new Error(
      `cannot resolve a project for ${cwd}; run ${PLATFORM_SLUG} pr merge from a registered checkout`,
    )
  }
  const landingBranch = project.settings.trunk?.trim()
  const release = project.settings.release
  if (!landingBranch || !release) {
    throw new Error(
      renderRefusal(
        refusal(`project ${project.name} has no landing branch and release policy`, {
          kind: 'edit',
          text: `${PLATFORM_SLUG} project set ${project.name} --settings '<settings with trunk and release>'`,
        }),
      ),
    )
  }
  const depthRefusal = shipToDepthRefusal(release.rungs, depth, project.name)
  if (depthRefusal) throw new Error(depthRefusal)
  return await completeMerge({
    target,
    cwd,
    adapter,
    database,
    project,
    landingBranch,
    requiredChecks: release.requiredChecks,
    mergeQueue: release.mergeQueue ?? false,
    mergeMethod: release.mergeMethod,
    releaseRequired,
    depth,
  })
}
