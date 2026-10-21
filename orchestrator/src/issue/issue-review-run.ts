// concern: filed-issue review adapter
/** Resolves review tier, dispatches its lenses, and gathers results without judging them. */

import { type CollectedWaitRun, collectWaitForRuns } from '../collect/collect.ts'
import { db } from '../database/db.ts'
import type { Project } from '../project/projects.ts'
import { parseReviewOutput } from '../review/review.ts'
import { resolveReviewMergeBase } from '../review/review-target.ts'
import { reviewTierForRange } from '../review/review-tier-service.ts'
import { detach } from '../run/run-dispatch.ts'
import { RUN_FOLLOW_TIMEOUT_MS } from '../run/run-liveness.ts'
import type { RunResult } from '../run/run-types.ts'
import { boundedIssuePack, type FiledIssue } from './issue-file.ts'
import {
  ISSUE_BLAST_RADIUS_LENS,
  type IssueReviewLensResult,
  issueReviewLenses,
  issueReviewRunLabel,
} from './issue-review.ts'

const POLL_MS = 100

type ReviewLaunch = { runId: string | null; failedToRun: string | null }
type DispatchResult<T> = { claim: T; dispatchNext: boolean }

type IssueReviewOperations = {
  dispatch(lens: string, distinctModels: readonly string[]): Promise<DispatchResult<ReviewLaunch>>
  blocked(lens: string, blockingLens: string): ReviewLaunch
  gather(lens: string, claim: ReviewLaunch): Promise<IssueReviewLensResult>
  modelForRun(runId: string): string
}

/** Fan out primary lenses, then gather the first declared opinion before routing its repeat. */
export async function dispatchThenGatherIssueReviews(
  lenses: readonly string[],
  secondOpinion: string | undefined,
  operations: IssueReviewOperations,
): Promise<IssueReviewLensResult[]> {
  const claims: { lens: string; claim: ReviewLaunch }[] = []
  let blockingLens: string | null = null
  for (const lens of lenses) {
    if (blockingLens !== null) {
      claims.push({ lens, claim: operations.blocked(lens, blockingLens) })
      continue
    }
    const launched = await operations.dispatch(lens, [])
    claims.push({ lens, claim: launched.claim })
    if (!launched.dispatchNext) blockingLens = lens
  }
  const gathered = claims.map(({ lens, claim }) => operations.gather(lens, claim))
  if (!secondOpinion) return Promise.all(gathered)

  const firstIndex = claims.findIndex(({ lens }) => lens === secondOpinion)
  if (firstIndex === -1) return Promise.all(gathered)
  await gathered[firstIndex]
  const firstRunId = claims[firstIndex]!.claim.runId
  let repeated: IssueReviewLensResult
  if (firstRunId === null) {
    repeated = failedLens(
      secondOpinion,
      `the first ${secondOpinion} opinion did not start, so its model could not be excluded`,
      null,
    )
  } else {
    let excludedModel: string
    try {
      excludedModel = operations.modelForRun(firstRunId)
    } catch (cause) {
      repeated = failedLens(secondOpinion, String((cause as Error)?.message ?? cause), null)
      const results = await Promise.all(gathered)
      results.splice(firstIndex + 1, 0, repeated)
      return results
    }
    const launched = await operations.dispatch(secondOpinion, [excludedModel])
    repeated = await operations.gather(secondOpinion, launched.claim)
  }
  const results = await Promise.all(gathered)
  results.splice(firstIndex + 1, 0, repeated)
  return results
}

export async function runIssueFixReviews(input: {
  issue: FiledIssue
  fixRun: RunResult
  target: Project
  branchKey: string
}): Promise<{
  tier: 0 | 1 | 2 | 3 | null
  selectedLenses: string[]
  reviewNotStarted: string | null
  results: IssueReviewLensResult[]
}> {
  const { issue, fixRun, target, branchKey } = input
  if (!fixRun.worktree) {
    return reviewNotStarted(`fix run ${fixRun.number} has no worktree to review`)
  }
  const worktree = fixRun.worktree
  const trunk = target.settings.trunk?.trim()
  if (!trunk) {
    return reviewNotStarted(`project ${target.name} has no trunk configured`)
  }
  let reviewBase: string | null
  try {
    reviewBase = resolveReviewMergeBase(worktree.path, worktree.branch, trunk)
  } catch (cause) {
    return reviewNotStarted(String((cause as Error)?.message ?? cause))
  }
  if (reviewBase === null) {
    return reviewNotStarted(
      `cannot find merge-base between branch ${worktree.branch} and trunk ${trunk}`,
    )
  }
  let tier: ReturnType<typeof reviewTierForRange>
  try {
    tier = reviewTierForRange(worktree.path, reviewBase, worktree.branch, target.settings.review)
  } catch (cause) {
    return reviewNotStarted(String((cause as Error)?.message ?? cause))
  }
  const lenses = issueReviewLenses(tier.lenses)
  const results = await dispatchThenGatherIssueReviews(lenses, tier.secondOpinion, {
    dispatch: async (lens, distinctModels): Promise<DispatchResult<ReviewLaunch>> => {
      let runId: string
      try {
        runId = await detach('review-lens', reviewPrompt(issue, lens, tier.tier), {
          cwd: worktree.path,
          lens,
          key: branchKey,
          carry: true,
          review: worktree.branch,
          // Route across another eligible lane instead of exceeding one whose
          // registration declares it is at capacity.
          noWaitCapacity: true,
          distinctModels: [...distinctModels],
          label: issueReviewRunLabel(issue.key, lens),
        })
      } catch (cause) {
        return {
          claim: {
            runId: errorRunId(cause),
            failedToRun: String((cause as Error)?.message ?? cause),
          },
          dispatchNext: true,
        }
      }
      try {
        const dispatchNext = await waitUntilRoutingCounts(runId)
        return { claim: { runId, failedToRun: null }, dispatchNext }
      } catch {
        // A returned id is always gathered. A routing observation failure may
        // not release another lens into capacity that this run could claim.
        return { claim: { runId, failedToRun: null }, dispatchNext: false }
      }
    },
    blocked: (lens, blockingLens) => ({
      runId: null,
      failedToRun: `${lens} was not dispatched because ${blockingLens} remained pending for ${followDuration()}`,
    }),
    gather: async (lens, launch): Promise<IssueReviewLensResult> => {
      if (launch.runId === null) {
        return failedLens(lens, launch.failedToRun ?? 'review run did not start', launch.runId)
      }
      try {
        const collected = await collectWaitForRuns(db(), [launch.runId], {
          timeoutMs: RUN_FOLLOW_TIMEOUT_MS,
        })
        if (collected.kind === 'timed-out') {
          throw new Error(`run ${launch.runId} did not finish within ${followDuration()}`)
        }
        const lensRun = collected.runs[0]!
        if (lensRun.status !== 'ok') {
          return failedLens(lens, failedReviewReason(lensRun), lensRun.finalId)
        }
        const review = parseReviewOutput(lensRun.output)
        if (!review) throw new Error(`run ${lensRun.finalId} returned no review output`)
        return {
          lens,
          finished: true,
          failedToRun: null,
          findingCount: review.findings.length,
          findings: review.findings,
          runId: lensRun.finalId,
        }
      } catch (cause) {
        return failedLens(lens, String((cause as Error)?.message ?? cause), launch.runId)
      }
    },
    modelForRun,
  })
  return { tier: tier.tier, selectedLenses: tier.lenses, reviewNotStarted: null, results }
}

function modelForRun(runId: string): string {
  const row = db().query('SELECT model FROM run WHERE record_id=?').get(runId) as {
    model: string | null
  } | null
  if (!row?.model) throw new Error(`run ${runId} recorded no model for second opinion to exclude`)
  return row.model
}

function reviewPrompt(issue: FiledIssue, lens: string, tier: 0 | 1 | 2 | 3): string {
  return lens === ISSUE_BLAST_RADIUS_LENS
    ? `Independently inspect task ${issue.key} and the current commit/diff. What is wrong with this change through the single lens: what else uses what it touched? Do not seek agreement and do not use any worker conclusion. Task filing:\n${boundedIssuePack(issue)}`
    : `Independently inspect task ${issue.key} and the current commit/diff through the ${lens} lens selected by review tier ${tier}. Do not seek agreement and do not use any worker conclusion. Task filing:\n${boundedIssuePack(issue)}`
}

async function waitUntilRoutingCounts(runId: string): Promise<boolean> {
  const deadline = Date.now() + RUN_FOLLOW_TIMEOUT_MS
  for (;;) {
    const row = db().query('SELECT agent,status,error FROM run WHERE record_id=?').get(runId) as {
      agent: string
      status: string
      error: string | null
    } | null
    if (!row || row.agent !== '(pending)' || row.status !== 'running') return true
    if (Date.now() >= deadline) return false
    await pollDelay()
  }
}

function followDuration(): string {
  return `${Math.round(RUN_FOLLOW_TIMEOUT_MS / 60_000)}m`
}

function reviewNotStarted(reason: string) {
  return {
    tier: null,
    selectedLenses: [],
    reviewNotStarted: reason,
    results: [],
  }
}

function failedReviewReason(run: CollectedWaitRun): string {
  return `run ${run.finalId} ended ${run.status}: ${run.error ?? (run.output.trim() || `exit ${run.exitCode}`)}`
}

function errorRunId(cause: unknown): string | null {
  const runId = (cause as { runId?: unknown })?.runId
  return typeof runId === 'string' ? runId : null
}

function pollDelay(): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, POLL_MS))
}

function failedLens(lens: string, reason: string, runId: string | null): IssueReviewLensResult {
  return {
    lens,
    finished: false,
    failedToRun: reason,
    findingCount: null,
    findings: null,
    runId,
  }
}
