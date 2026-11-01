// concern: pull-request merge
/**
 * Resolves forge and local proof facts, then performs an admitted merge.
 * The landing branch can still move between its fetch and the merge because the forge cannot condition a merge on the base tip without branch protection.
 */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { recordMergeBranchLandings } from '../branch/branch-landing-service.ts'
import { enableSchemaReload, writableDb } from '../database/db.ts'
import { passingGateForCommit } from '../gate/gate-passed.ts'
import { targetGitEnvironment } from '../git/git-environment.ts'
import { currentProjectRepository, type Project, projectAt } from '../project/projects.ts'
import { type RequiredReleaseReport, releaseRequiredRungs } from '../release/release-required.ts'
import { type ShipCleanupReport, shipCleanup } from '../ship-cleanup/ship-cleanup.ts'
import { matchWorkflowTreePath } from '../workflow/workflow-tree.ts'
import type { AdmissionDecision } from './admission-decision.ts'
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
  interpretMergeQueue,
  MERGE_QUEUE_WAIT_MS,
  type MergeQueueObservation,
  type MergeQueueWaitState,
  mergeQueueEnqueueFailureRemedy,
  stepMergeQueueWait,
} from './merge-queue-decision.ts'
import {
  enqueuePullRequest,
  githubFailedMergeGroupRun,
  githubMergeQueueState,
  requeuePullRequest,
} from './merge-queue-forge.ts'
import {
  admissionDecision,
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

export type { PullRequestMergeFacts } from './pr-merge-evidence.ts'
export type { PullRequestMergeOutcome } from './pr-post-landing.ts'

export type PullRequestMergeAdapter = {
  repository(project: Project): string | null
  view(cwd: string, target: string): PullRequestMergeFacts
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
  ): { change: PullRequestChange; decision: AdmissionDecision }
  recordAdmission(
    change: PullRequestChange,
    decision: AdmissionDecision,
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
  releaseRequired(
    project: Project,
    mergeCommit: string,
    target: string,
    enabled: boolean,
  ): RequiredReleaseReport
  shipCleanup?(
    project: string,
    branch: string,
    prNumber: number,
    database: Database,
  ): ShipCleanupReport
  postLanding?: PullRequestPostLandingAdapter
}

type ProcessResult = { exitCode: number; stdout: string; stderr: string }

function run(cwd: string, argv: string[]): ProcessResult {
  const result = Bun.spawnSync(argv, {
    cwd,
    env: targetGitEnvironment(cwd),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
  }
}

function successful(cwd: string, argv: string[], label: string): string {
  const result = run(cwd, argv)
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
      headRefOid?: unknown
      headRefName?: unknown
      baseRefName?: unknown
      title?: unknown
      state?: unknown
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
          'id,number,headRefOid,headRefName,baseRefName,title,state,mergeCommit',
        ],
        'pull-request lookup',
      ),
      'pull-request lookup',
    )
    if (
      typeof value.id !== 'string' ||
      !Number.isSafeInteger(value.number) ||
      typeof value.headRefOid !== 'string' ||
      typeof value.headRefName !== 'string' ||
      typeof value.baseRefName !== 'string' ||
      typeof value.title !== 'string' ||
      typeof value.state !== 'string'
    ) {
      throw new Error('pull-request lookup returned an unexpected JSON shape')
    }
    return {
      nodeId: value.id,
      number: Number(value.number),
      headCommit: value.headRefOid,
      headBranch: value.headRefName,
      baseBranch: value.baseRefName,
      title: value.title,
      state: value.state,
      mergeCommit: typeof value.mergeCommit?.oid === 'string' ? value.mergeCommit.oid : null,
    }
  },
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
  admission(cwd, headCommit, headBranch, database) {
    const change = resolvePullRequestChange(cwd, headCommit, database, undefined, headBranch)
    return { change, decision: admissionDecision(change, database) }
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
  releaseRequired(project, mergeCommit, _target, enabled) {
    return releaseRequiredRungs({ project, mergeCommit, releaseRequired: enabled })
  },
  shipCleanup(project, branch, _prNumber, database) {
    return shipCleanup(branch, { project, confirmedLanded: true, database })
  },
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
  } catch {
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
  const deadline = adapter.now() + MERGE_QUEUE_WAIT_MS
  let waitState: MergeQueueWaitState = {
    enqueueSubmitted: false,
    activeEntryObserved: false,
    dequeueObservedAt: null,
    requeuePendingSince: null,
  }
  let requeueOutput: string | undefined
  while (true) {
    const observation = adapter.queueState(cwd, pullRequest.nodeId)
    const state = interpretMergeQueue(observation)
    const now = adapter.now()
    const step = stepMergeQueueWait(pullRequest.number, waitState, state, now, deadline)
    waitState = step.state
    const action = step.action
    if (action.action === 'complete') {
      return {
        mergeCommit: action.mergeCommit,
        ...(requeueOutput ? { requeueOutput } : {}),
      }
    }
    if (action.action === 'refuse') {
      const evidence =
        state.state === 'failed'
          ? `; ${failedMergeGroupRunEvidence(pullRequest, cwd, repository, observation.enqueuedAt, adapter)}`
          : ''
      throw new Error(`refusing merge: ${action.refusal}${evidence}; cleared by: ${action.remedy}`)
    }
    if (action.action === 'enqueue') {
      enqueueForMergeQueue(pullRequest, cwd, adapter, target)
      continue
    }
    if (action.action === 'requeue') {
      const evidence = failedMergeGroupRunEvidence(
        pullRequest,
        cwd,
        repository,
        observation.enqueuedAt,
        adapter,
      )
      requeueForMergeQueue(pullRequest, cwd, adapter, evidence, target)
      requeueOutput = `requeued #${pullRequest.number} at ${pullRequest.headCommit} after ${evidence}`
      continue
    }
    adapter.wait(action.delay)
  }
}

function failedMergeGroupRunEvidence(
  pullRequest: PullRequestMergeFacts,
  cwd: string,
  repository: string | null,
  enqueuedAt: string | null,
  adapter: PullRequestMergeAdapter,
): string {
  if (!repository) return 'failed merge-group run could not be read: repository identity is absent'
  if (!enqueuedAt) {
    return 'failed merge-group run could not be read: the queue entry has no enqueue time'
  }
  try {
    const run = adapter.failedMergeGroupRun(
      cwd,
      repository,
      pullRequest.baseBranch,
      pullRequest.number,
      enqueuedAt,
    )
    return run
      ? `${run.conclusion} merge-group run ${run.id} (${run.url})`
      : `no merge-group run that failed since ${enqueuedAt} was found`
  } catch (cause) {
    return `failed merge-group run could not be read: ${cause instanceof Error ? cause.message : String(cause)}`
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

type CheckedMergeAdmission = ReturnType<PullRequestMergeAdapter['admission']>

function collectMergeAdmission(
  pullRequest: PullRequestMergeFacts,
  cwd: string,
  adapter: PullRequestMergeAdapter,
  database: Database,
): { decision: MergeDecision; checked: CheckedMergeAdmission | null } {
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
  const checked = adapter.admission(cwd, pullRequest.headCommit, pullRequest.headBranch, database)
  if (checked.decision.complete) {
    return {
      checked,
      decision: decideMergeAdmission({
        checked: true,
        number: pullRequest.number,
        complete: true,
      }),
    }
  }
  const triage = checked.decision.triage
  if (triage.complete) throw new Error('incomplete admission returned complete review triage')
  return {
    checked,
    decision: decideMergeAdmission({
      checked: true,
      number: pullRequest.number,
      complete: false,
      triageRefusal: triageRefusal(checked.change, triage),
    }),
  }
}

function refuseUnlessAdmitted(decision: MergeDecision): void {
  if (!decision.admitted) throw new Error(`refusing merge: ${decision.refusal}`)
}

function admitViewedPullRequest(
  pullRequest: PullRequestMergeFacts,
  input: {
    cwd: string
    adapter: PullRequestMergeAdapter
    database: Database
    landingBranch: string
    requiredChecks: readonly string[]
    mergeQueue: boolean
  },
): PullRequestChange {
  refuseUnlessAdmitted(
    decidePullRequestIdentity({
      number: pullRequest.number,
      state: pullRequest.state,
      baseBranch: pullRequest.baseBranch,
      landingBranch: input.landingBranch,
    }),
  )
  const admission = collectMergeAdmission(pullRequest, input.cwd, input.adapter, input.database)
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

function completeMerge(input: {
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
}): PullRequestMergeOutcome {
  let pullRequest: PullRequestMergeFacts | undefined
  let mergeCommit = ''
  let mergeCommitLookupError: unknown
  let mergeCommitLookupFailed = false
  let requeueOutput: string | undefined
  let admittedChange: PullRequestChange
  try {
    pullRequest = input.adapter.view(input.cwd, input.target)
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
      admittedChange = admitViewedPullRequest(pullRequest, input)
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
  return completePullRequestPostLanding({
    adapter: {
      release: input.adapter.releaseRequired,
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
    workflowPromotionDue,
  })
}

export function mergePullRequest(
  target: string,
  cwd = process.cwd(),
  adapter: PullRequestMergeAdapter = cliPullRequestMergeAdapter,
  injectedDatabase?: Database,
  releaseRequired = false,
): PullRequestMergeOutcome {
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
      `project ${project.name} has no landing branch and release policy; cleared by: ${PLATFORM_SLUG} project set ${project.name} --settings '<settings with trunk and release>'`,
    )
  }
  return completeMerge({
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
  })
}
