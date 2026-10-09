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

type ReviewLaunch = { runId: number | null; failedToRun: string | null }
type DispatchResult<T> = { claim: T; dispatchNext: boolean }

/** Dispatch serially through the claim boundary, then gather concurrently in lens order. */
export async function dispatchThenGatherIssueReviews<TClaim, TResult>(
  lenses: readonly string[],
  dispatch: (lens: string) => Promise<DispatchResult<TClaim>>,
  blocked: (lens: string, blockingLens: string) => TClaim,
  gather: (lens: string, claim: TClaim) => Promise<TResult>,
): Promise<TResult[]> {
  const claims: { lens: string; claim: TClaim }[] = []
  let blockingLens: string | null = null
  for (const lens of lenses) {
    if (blockingLens !== null) {
      claims.push({ lens, claim: blocked(lens, blockingLens) })
      continue
    }
    const launched = await dispatch(lens)
    claims.push({ lens, claim: launched.claim })
    if (!launched.dispatchNext) blockingLens = lens
  }
  return Promise.all(claims.map(({ lens, claim }) => gather(lens, claim)))
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
    return reviewNotStarted(`fix run ${fixRun.id} has no worktree to review`)
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
  const results = await dispatchThenGatherIssueReviews(
    lenses,
    async (lens): Promise<DispatchResult<ReviewLaunch>> => {
      let runId: number
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
    (lens, blockingLens) => ({
      runId: null,
      failedToRun: `${lens} was not dispatched because ${blockingLens} remained pending for ${followDuration()}`,
    }),
    async (lens, launch): Promise<IssueReviewLensResult> => {
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
  )
  return { tier: tier.tier, selectedLenses: tier.lenses, reviewNotStarted: null, results }
}

function reviewPrompt(issue: FiledIssue, lens: string, tier: 0 | 1 | 2 | 3): string {
  return lens === ISSUE_BLAST_RADIUS_LENS
    ? `Independently inspect task ${issue.key} and the current commit/diff. What is wrong with this change through the single lens: what else uses what it touched? Do not seek agreement and do not use any worker conclusion. Task filing:\n${boundedIssuePack(issue)}`
    : `Independently inspect task ${issue.key} and the current commit/diff through the ${lens} lens selected by review tier ${tier}. Do not seek agreement and do not use any worker conclusion. Task filing:\n${boundedIssuePack(issue)}`
}

async function waitUntilRoutingCounts(runId: number): Promise<boolean> {
  const deadline = Date.now() + RUN_FOLLOW_TIMEOUT_MS
  for (;;) {
    const row = db().query('SELECT agent,status,error FROM run WHERE id=?').get(runId) as {
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

function errorRunId(cause: unknown): number | null {
  const runId = (cause as { runId?: unknown })?.runId
  return typeof runId === 'number' ? runId : null
}

function pollDelay(): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, POLL_MS))
}

function failedLens(lens: string, reason: string, runId: number | null): IssueReviewLensResult {
  return {
    lens,
    finished: false,
    failedToRun: reason,
    findingCount: null,
    findings: null,
    runId,
  }
}
