// concern: pull-request post-landing completion
/** Moves main once, fences the parent store, and runs all later work in the moved checkout. */

import type { Database } from 'bun:sqlite'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { bottegaEntryArgv } from '../../../shared/self-spawn.ts'
import { fenceStoreAfterCheckoutMove } from '../database/db.ts'
import type { Project } from '../project/projects.ts'
import { projectByName } from '../project/projects.ts'
import {
  changedPaths,
  failedRequiredRelease,
  formatRequiredReleaseReport,
  mainCheckoutHead,
  moveMainCheckout,
  type RequiredReleaseReport,
  type RequiredRungDecision,
  releaseRequiredFlagAbsent,
  releaseRequiredRungsAfterMainMove,
  requiredRungDecision,
  verifyMainCheckout,
} from '../release/release-required.ts'
import {
  formatShipCleanup,
  type ShipCleanupReport,
  shipCleanup,
} from '../ship-cleanup/ship-cleanup.ts'
import { SHIP_CLEANUP_RESIDUE_EXIT_CODE } from '../ship-cleanup/ship-cleanup-decision.ts'
import type { PullRequestMergeFacts } from './pr-merge-evidence.ts'
import {
  encodePullRequestPostLandingPayload,
  POST_LANDING_FLAG,
  type PullRequestPostLandingPayload,
  postLandingRecovery,
} from './pr-post-landing-payload.ts'

type WorkflowPromotionStage = 'fetch' | 'branch-check' | 'fast-forward' | 'promote'
export type WorkflowPromotionResult =
  | { ok: true; output: string }
  | { ok: false; stage: WorkflowPromotionStage; detail: string }

const MERGED_WITH_RESIDUE_EXIT_CODE = SHIP_CLEANUP_RESIDUE_EXIT_CODE
const MERGED_WITH_UNRELEASED_RUNG_EXIT_CODE = 21
export const POST_LANDING_REPORTED_EXIT_CODE = 22
export type PullRequestMergeOutcome = {
  output: string
  exitCode: number
}

export type PullRequestPostLandingAdapter = {
  changedPaths(project: Project, mergeCommit: string): string[]
  mainHead(project: Project): string
  moveMain(project: Project, mergeCommit: string): void
  fence(reason: string): void
  handOff(payload: PullRequestPostLandingPayload): PullRequestMergeOutcome
}

function moveMainForPostLanding(
  adapter: PullRequestPostLandingAdapter,
  project: Project,
  mergeCommit: string,
): { moved: true } | { moved: false; detail: string } {
  let headBefore: string
  try {
    headBefore = adapter.mainHead(project)
  } catch (cause) {
    return { moved: false, detail: cause instanceof Error ? cause.message : String(cause) }
  }
  let failure: string | null = null
  try {
    adapter.moveMain(project, mergeCommit)
  } catch (cause) {
    failure = cause instanceof Error ? cause.message : String(cause)
  }
  if (failure) {
    try {
      if (adapter.mainHead(project) === headBefore) return { moved: false, detail: failure }
    } catch {
      return { moved: true }
    }
  }
  return { moved: true }
}

const refuseRealPostLandingAdapterInTest = (): void => {
  if (process.env.NODE_ENV === 'test') {
    throw new Error(
      'real pull-request post-landing adapter refuses side effects under the test runner; inject a post-landing adapter',
    )
  }
}

const cliPostLandingAdapter: PullRequestPostLandingAdapter = {
  changedPaths,
  mainHead: mainCheckoutHead,
  moveMain(project, mergeCommit) {
    refuseRealPostLandingAdapterInTest()
    moveMainCheckout(project, mergeCommit)
  },
  fence: fenceStoreAfterCheckoutMove,
  handOff(payload) {
    refuseRealPostLandingAdapterInTest()
    try {
      const result = Bun.spawnSync(
        [...bottegaEntryArgv(PLATFORM_SLUG), 'pr', 'merge', payload.target, POST_LANDING_FLAG],
        {
          env: process.env,
          stdin: Buffer.from(encodePullRequestPostLandingPayload(payload)),
          stdout: 'pipe',
          stderr: 'inherit',
        },
      )
      return { exitCode: result.exitCode, output: result.stdout.toString().replace(/\n$/, '') }
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause)
      return {
        exitCode: MERGED_WITH_UNRELEASED_RUNG_EXIT_CODE,
        output: `post-landing hand-off failed: ${detail}; ${postLandingRecovery(payload.target)}`,
      }
    }
  },
}

/**
 * Untested at the process boundary by choice, matching workflow-evidence-handoff.ts: a spawn
 * failure and every child exit announce themselves, while the in-process adapter tests the
 * decision, exact payload, output, and exit-code propagation without spawning a repository.
 */

type RemainingStageAdapter = {
  release(
    project: Project,
    mergeCommit: string,
    target: string,
    enabled: boolean,
  ): RequiredReleaseReport
  cleanup?(project: string, branch: string, prNumber: number, database: Database): ShipCleanupReport
}

function promotionOutput(input: {
  result: WorkflowPromotionResult
  project: Project
  prNumber: number
  mergeCommit: string
}): { output: string; error?: string } {
  if (input.result.ok) return { output: input.result.output }
  const reason = `merged PR #${input.prNumber} (${input.mergeCommit})`
  const promotion = `${PLATFORM_SLUG} workflow promote-tree --cwd ${input.project.path} --reason "${reason}"`
  const command =
    input.result.stage === 'fetch'
      ? `git -C ${input.project.path} fetch origin, then git -C ${input.project.path} merge --ff-only ${input.mergeCommit}, then ${promotion}`
      : input.result.stage === 'branch-check'
        ? `put checkout ${input.project.path} on trunk ${input.project.settings.trunk}, then git -C ${input.project.path} merge --ff-only ${input.mergeCommit}, then ${promotion}`
        : input.result.stage === 'fast-forward'
          ? `git -C ${input.project.path} merge --ff-only ${input.mergeCommit}, then ${promotion}`
          : promotion
  return {
    output: `workflow draft promotion failed at ${input.result.stage}: ${input.result.detail}; clear with: ${command}`,
    error: input.result.detail,
  }
}

function mergedOutput(input: {
  adapter: Pick<RemainingStageAdapter, 'cleanup'>
  database: Database
  project: string
  branch: string
  prNumber: number
  mergeCommit: string
  recordingError?: string
  promotion: { output: string; error?: string }
  requeueOutput?: string
  requiredRelease: RequiredReleaseReport
  target: string
}): PullRequestMergeOutcome {
  const addRequeue = (outcome: PullRequestMergeOutcome): PullRequestMergeOutcome => ({
    ...outcome,
    output: input.requeueOutput ? `${outcome.output}\n${input.requeueOutput}` : outcome.output,
  })
  if (input.recordingError) {
    const promotion = input.promotion.output ? `\n${input.promotion.output}` : ''
    return addRequeue({
      output:
        `pull request #${input.prNumber} merged as ${input.mergeCommit}\n` +
        `${input.recordingError}; recover landing evidence with: ${PLATFORM_SLUG} tree branch landed ${input.branch} --pr ${input.prNumber}; cleanup was not run${promotion}`,
      exitCode: MERGED_WITH_RESIDUE_EXIT_CODE,
    })
  }
  const release = formatRequiredReleaseReport(input.requiredRelease, input.target, input.project)
  const parts = [input.mergeCommit, input.promotion.output, release].filter(Boolean)
  let cleanupExit: 0 | typeof MERGED_WITH_RESIDUE_EXIT_CODE = input.promotion.error
    ? MERGED_WITH_RESIDUE_EXIT_CODE
    : 0
  if (!input.adapter.cleanup) {
    return addRequeue({
      output: parts.join('\n'),
      exitCode: input.requiredRelease.satisfied
        ? cleanupExit
        : MERGED_WITH_UNRELEASED_RUNG_EXIT_CODE,
    })
  }
  try {
    const report = input.adapter.cleanup(
      input.project,
      input.branch,
      input.prNumber,
      input.database,
    )
    parts.push(formatShipCleanup(report))
    if (!report.verdict.clean) cleanupExit = MERGED_WITH_RESIDUE_EXIT_CODE
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    parts.push(
      `ship cleanup failed for ${input.branch}: ${detail}; retry: ${PLATFORM_SLUG} tree ship-cleanup ${input.branch}`,
    )
    cleanupExit = MERGED_WITH_RESIDUE_EXIT_CODE
  }
  return addRequeue({
    output: parts.join('\n'),
    exitCode: input.requiredRelease.satisfied ? cleanupExit : MERGED_WITH_UNRELEASED_RUNG_EXIT_CODE,
  })
}

export function completePullRequestPostLanding(input: {
  adapter: RemainingStageAdapter
  postLandingAdapter?: PullRequestPostLandingAdapter
  database: Database
  project: Project
  pullRequest: PullRequestMergeFacts
  mergeCommit: string
  target: string
  releaseRequired: boolean
  workflowPromotionDue: boolean
  recordingError?: string
  requeueOutput?: string
}): PullRequestMergeOutcome {
  const post = input.postLandingAdapter ?? cliPostLandingAdapter
  const inspect = input.workflowPromotionDue || input.releaseRequired
  const decision: RequiredRungDecision = inspect
    ? requiredRungDecision(input.project, () => post.changedPaths(input.project, input.mergeCommit))
    : { decided: true, required: [], error: null }
  const mustMove =
    input.workflowPromotionDue || (input.releaseRequired && decision.required.length > 0)
  if (!mustMove) {
    return mergedOutput({
      ...input,
      project: input.project.name,
      branch: input.pullRequest.headBranch,
      prNumber: input.pullRequest.number,
      promotion: { output: '' },
      requiredRelease: input.adapter.release(
        input.project,
        input.mergeCommit,
        input.target,
        input.releaseRequired,
      ),
    })
  }
  const move = moveMainForPostLanding(post, input.project, input.mergeCommit)
  if (!move.moved) {
    return mergedOutput({
      ...input,
      project: input.project.name,
      branch: input.pullRequest.headBranch,
      prNumber: input.pullRequest.number,
      promotion: input.workflowPromotionDue
        ? promotionOutput({
            result: { ok: false, stage: 'fast-forward', detail: move.detail },
            project: input.project,
            prNumber: input.pullRequest.number,
            mergeCommit: input.mergeCommit,
          })
        : { output: '' },
      requiredRelease: failedRequiredRelease(
        decision.required,
        decision.decided ? move.detail : decision.error,
      ),
    })
  }
  const payload: PullRequestPostLandingPayload = {
    project: input.project.name,
    target: input.target,
    prNumber: input.pullRequest.number,
    headBranch: input.pullRequest.headBranch,
    headCommit: input.pullRequest.headCommit,
    mergeCommit: input.mergeCommit,
    requiredRungs: decision.required,
    rungDecisionError: decision.error,
    releaseRequired: input.releaseRequired,
    promoteWorkflowDrafts: input.workflowPromotionDue,
    recordingError: input.recordingError ?? null,
    requeueOutput: input.requeueOutput ?? null,
  }
  post.fence(`main checkout moved to include ${input.mergeCommit}`)
  const handedOff = post.handOff(payload)
  const unexpectedExit = ![
    0,
    MERGED_WITH_RESIDUE_EXIT_CODE,
    MERGED_WITH_UNRELEASED_RUNG_EXIT_CODE,
    POST_LANDING_REPORTED_EXIT_CODE,
  ].includes(handedOff.exitCode)
  const recovery = unexpectedExit
    ? `post-landing steps (promotion, rungs, cleanup) did not complete; ${postLandingRecovery(input.target)}`
    : ''
  if (!recovery) return handedOff
  return { output: `${handedOff.output}\n${recovery}`, exitCode: handedOff.exitCode }
}

function promoteWorkflowTree(project: Project, reason: string): WorkflowPromotionResult {
  const result = Bun.spawnSync(
    [
      join(project.path, 'bin', PLATFORM_SLUG),
      'workflow',
      'promote-tree',
      '--cwd',
      project.path,
      '--reason',
      reason,
    ],
    { cwd: project.path, env: process.env, stdout: 'pipe', stderr: 'pipe' },
  )
  if (result.exitCode === 0) return { ok: true, output: result.stdout.toString().trim() }
  return {
    ok: false,
    stage: 'promote',
    detail: result.stderr.toString().trim() || `exit ${result.exitCode}`,
  }
}

export type PullRequestPostLandingChildAdapter = {
  project(name: string, database: Database): Project | null
  verify(project: Project, mergeCommit: string): void
  promote(project: Project, reason: string): WorkflowPromotionResult
  release(input: {
    project: Project
    mergeCommit: string
    required: string[]
  }): RequiredReleaseReport
  cleanup(project: string, branch: string, prNumber: number, database: Database): ShipCleanupReport
}

const cliChildAdapter: PullRequestPostLandingChildAdapter = {
  project: projectByName,
  verify: verifyMainCheckout,
  promote: promoteWorkflowTree,
  release: releaseRequiredRungsAfterMainMove,
  cleanup: (projectName, branch, _prNumber, database) =>
    shipCleanup(branch, { project: projectName, confirmedLanded: true, database }),
}

export function runPullRequestPostLanding(
  payload: PullRequestPostLandingPayload,
  database: Database,
  adapter: PullRequestPostLandingChildAdapter = cliChildAdapter,
): PullRequestMergeOutcome {
  const project = adapter.project(payload.project, database)
  if (!project) throw new Error(`post-landing project ${payload.project} is not registered`)
  let checkoutFailure: string | null = null
  try {
    adapter.verify(project, payload.mergeCommit)
  } catch (cause) {
    checkoutFailure = cause instanceof Error ? cause.message : String(cause)
  }
  const promotion = promotionOutput({
    result:
      checkoutFailure && payload.promoteWorkflowDrafts
        ? { ok: false, stage: 'branch-check', detail: checkoutFailure }
        : payload.promoteWorkflowDrafts
          ? adapter.promote(project, `merged PR #${payload.prNumber} (${payload.mergeCommit})`)
          : { ok: true, output: '' },
    project,
    prNumber: payload.prNumber,
    mergeCommit: payload.mergeCommit,
  })
  const requiredRelease = payload.rungDecisionError
    ? failedRequiredRelease(payload.requiredRungs, payload.rungDecisionError)
    : checkoutFailure
      ? failedRequiredRelease(payload.requiredRungs, checkoutFailure)
      : payload.releaseRequired
        ? adapter.release({
            project,
            mergeCommit: payload.mergeCommit,
            required: payload.requiredRungs,
          })
        : releaseRequiredFlagAbsent(payload.requiredRungs)
  return mergedOutput({
    adapter: { cleanup: adapter.cleanup },
    database,
    project: project.name,
    branch: payload.headBranch,
    prNumber: payload.prNumber,
    mergeCommit: payload.mergeCommit,
    promotion,
    requiredRelease,
    target: payload.target,
    recordingError: payload.recordingError ?? undefined,
    requeueOutput: payload.requeueOutput ?? undefined,
  })
}
