// concern: filed-issue review adapter
/** Resolves review tier, dispatches its lenses, and gathers results without judging them. */

import { existsSync, readFileSync } from 'node:fs'
import { resolveFailover } from '../collect/collect.ts'
import { db } from '../database/db.ts'
import { outcomeOf } from '../outcome.ts'
import type { Project } from '../project/projects.ts'
import { parseReviewOutput } from '../review/review.ts'
import { resolveReviewMergeBase } from '../review/review-target.ts'
import { reviewTierForRange } from '../review/review-tier-service.ts'
import { detach } from '../run/run-dispatch.ts'
import { reapStale, STALE_AFTER_MS } from '../run/run-liveness.ts'
import type { RunResult } from '../run/run-types.ts'
import { boundedIssuePack, type FiledIssue } from './issue-file.ts'
import {
  ISSUE_BLAST_RADIUS_LENS,
  type IssueReviewLensResult,
  issueReviewLenses,
  issueReviewRunLabel,
} from './issue-review.ts'

const ROUTE_CLAIM_TIMEOUT_MS = 30_000
const REVIEW_FOLLOW_TIMEOUT_MS = STALE_AFTER_MS + 60_000
const POLL_MS = 100

type ReviewLaunch = { runId: number | null; failedToRun: string | null }
type DetachedReviewResult = {
  id: number
  status: string
  output: string
  error: string | null
  exitCode: number | null
}

/** Dispatch serially through the claim boundary, then gather concurrently in lens order. */
export async function dispatchThenGatherIssueReviews<TClaim, TResult>(
  lenses: readonly string[],
  dispatch: (lens: string) => Promise<TClaim>,
  gather: (lens: string, claim: TClaim) => Promise<TResult>,
): Promise<TResult[]> {
  const claims: { lens: string; claim: TClaim }[] = []
  for (const lens of lenses) claims.push({ lens, claim: await dispatch(lens) })
  return Promise.all(claims.map(({ lens, claim }) => gather(lens, claim)))
}

export async function runIssueFixReviews(input: {
  issue: FiledIssue
  fixRun: RunResult
  target: Project
  branchKey: string
}): Promise<{ tier: 0 | 1 | 2 | 3; selectedLenses: string[]; results: IssueReviewLensResult[] }> {
  const { issue, fixRun, target, branchKey } = input
  if (!fixRun.worktree) throw new Error(`fix run ${fixRun.id} has no worktree to review`)
  const worktree = fixRun.worktree
  const trunk = target.settings.trunk?.trim()
  if (!trunk) throw new Error(`project ${target.name} has no trunk configured`)
  const reviewBase = resolveReviewMergeBase(worktree.path, worktree.branch, trunk)
  if (!reviewBase) {
    throw new Error(`cannot find merge-base between branch ${worktree.branch} and trunk ${trunk}`)
  }
  const tier = reviewTierForRange(
    worktree.path,
    reviewBase,
    worktree.branch,
    target.settings.review,
  )
  const lenses = issueReviewLenses(tier.lenses)
  const results = await dispatchThenGatherIssueReviews(
    lenses,
    async (lens): Promise<ReviewLaunch> => {
      let runId: number | null = null
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
        await waitUntilRoutingCounts(runId)
        return { runId, failedToRun: null }
      } catch (cause) {
        return {
          runId: runId ?? errorRunId(cause),
          failedToRun: String((cause as Error)?.message ?? cause),
        }
      }
    },
    async (lens, launch): Promise<IssueReviewLensResult> => {
      if (launch.failedToRun !== null) {
        return failedLens(lens, launch.failedToRun, launch.runId)
      }
      try {
        const lensRun = await gatherDetachedReview(launch.runId!)
        if (lensRun.status !== 'ok') {
          return failedLens(lens, failedReviewReason(lensRun), lensRun.id)
        }
        const review = parseReviewOutput(lensRun.output)
        if (!review) throw new Error(`run ${lensRun.id} returned no review output`)
        return {
          lens,
          finished: true,
          failedToRun: null,
          findingCount: review.findings.length,
          findings: review.findings,
          runId: lensRun.id,
        }
      } catch (cause) {
        return failedLens(lens, String((cause as Error)?.message ?? cause), launch.runId)
      }
    },
  )
  return { tier: tier.tier, selectedLenses: tier.lenses, results }
}

function reviewPrompt(issue: FiledIssue, lens: string, tier: 0 | 1 | 2 | 3): string {
  return lens === ISSUE_BLAST_RADIUS_LENS
    ? `Independently inspect task ${issue.key} and the current commit/diff. What is wrong with this change through the single lens: what else uses what it touched? Do not seek agreement and do not use any worker conclusion. Task filing:\n${boundedIssuePack(issue)}`
    : `Independently inspect task ${issue.key} and the current commit/diff through the ${lens} lens selected by review tier ${tier}. Do not seek agreement and do not use any worker conclusion. Task filing:\n${boundedIssuePack(issue)}`
}

async function waitUntilRoutingCounts(runId: number): Promise<void> {
  const deadline = Date.now() + ROUTE_CLAIM_TIMEOUT_MS
  for (;;) {
    const row = db().query('SELECT agent,status,error FROM run WHERE id=?').get(runId) as {
      agent: string
      status: string
      error: string | null
    } | null
    if (!row) throw new Error(`detached review run ${runId} disappeared before routing`)
    if (row.agent !== '(pending)' || row.status !== 'running') return
    if (Date.now() >= deadline) {
      throw new Error(`run ${runId} was not claimed by routing within 30s`)
    }
    await pollDelay()
  }
}

async function gatherDetachedReview(runId: number): Promise<DetachedReviewResult> {
  const deadline = Date.now() + REVIEW_FOLLOW_TIMEOUT_MS
  for (;;) {
    const chain = resolveFailover(db(), runId)
    const row = db()
      .query('SELECT id,status,output_path,error,exit_code FROM run WHERE id=?')
      .get(chain.finalId) as {
      id: number
      status: string
      output_path: string | null
      error: string | null
      exit_code: number | null
    } | null
    if (row && outcomeOf(row).terminal && !chain.settling) {
      return {
        id: row.id,
        status: row.status,
        output:
          row.output_path && existsSync(row.output_path)
            ? readFileSync(row.output_path, 'utf8')
            : '',
        error: row.error,
        exitCode: row.exit_code,
      }
    }
    if (Date.now() >= deadline) throw new Error(`run ${runId} did not finish within 61m`)
    reapStale()
    await pollDelay()
  }
}

function failedReviewReason(run: DetachedReviewResult): string {
  return `run ${run.id} ended ${run.status}: ${run.error ?? (run.output.trim() || `exit ${run.exitCode}`)}`
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
