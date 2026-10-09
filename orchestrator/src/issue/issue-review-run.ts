// concern: filed-issue review adapter
/** Resolves review tier, dispatches its lenses, and gathers results without judging them. */

import type { Project } from '../project/projects.ts'
import { parseReviewOutput } from '../review/review.ts'
import { resolveReviewMergeBase } from '../review/review-target.ts'
import { reviewTierForRange } from '../review/review-tier-service.ts'
import { run } from '../run/run.ts'
import type { RunResult } from '../run/run-types.ts'
import { boundedIssuePack, type FiledIssue } from './issue-file.ts'
import {
  ISSUE_BLAST_RADIUS_LENS,
  type IssueReviewLensResult,
  issueReviewLenses,
} from './issue-review.ts'

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
  const results = await Promise.all(
    issueReviewLenses(tier.lenses).map(async (lens): Promise<IssueReviewLensResult> => {
      let lensRun: RunResult | null = null
      try {
        lensRun = await run({
          job: 'review-lens',
          cwd: worktree.path,
          lens,
          key: branchKey,
          carry: true,
          review: worktree.branch,
          // Route across another eligible lane instead of exceeding one whose
          // registration declares it is at capacity.
          noWaitCapacity: true,
          prompt:
            lens === ISSUE_BLAST_RADIUS_LENS
              ? `Independently inspect task ${issue.key} and the current commit/diff. What is wrong with this change through the single lens: what else uses what it touched? Do not seek agreement and do not use any worker conclusion. Task filing:\n${boundedIssuePack(issue)}`
              : `Independently inspect task ${issue.key} and the current commit/diff through the ${lens} lens selected by review tier ${tier.tier}. Do not seek agreement and do not use any worker conclusion. Task filing:\n${boundedIssuePack(issue)}`,
          label:
            lens === ISSUE_BLAST_RADIUS_LENS
              ? `issue ${issue.key} blast radius`
              : `issue ${issue.key} review ${lens}`,
        })
        if (lensRun.status !== 'ok') {
          return failedLens(
            lens,
            `run ${lensRun.id} ended ${lensRun.status}: ${lensRun.output.trim() || `exit ${lensRun.exitCode}`}`,
            lensRun.id,
          )
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
        return failedLens(lens, String((cause as Error)?.message ?? cause), lensRun?.id ?? null)
      }
    }),
  )
  return { tier: tier.tier, selectedLenses: tier.lenses, results }
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
