// concern: review
/** Selects and renders triaged review findings for a writing continuation. */
import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { gitContext } from '../git/git-environment.ts'
import { projectByName } from '../project/projects.ts'
import {
  type ChangeGroup,
  measureChangeGroup,
  reviewRoundTriageComplete,
  reviewsForTriage,
} from './review-group.ts'

export type ContinuationFinding = {
  reviewId: number
  ordinal: number
  lens: string
  reviewerSeverity: string
  triagedSeverity: string | null
  disposition: 'accepted' | 'modified'
  location: string
  evidence: string
  proposedCorrection: string
}

function selectedFindings(database: Database, group: ChangeGroup): ContinuationFinding[] {
  const round = reviewsForTriage(database, group).reviews
  if (!round.length) {
    throw new Error(
      `no reviews match the current change group for branch ${group.branch}\n` +
        'cleared by: run and judge the review lenses for the current change',
    )
  }
  const incomplete = round.filter((review) => !reviewRoundTriageComplete(review))
  if (incomplete.length) {
    const details = incomplete.map((review) => {
      const ordinals = review.findings
        .filter(({ disposition }) => disposition === null)
        .map(({ ordinal }) => ordinal)
      return ordinals.length
        ? `review ${review.reviewId}: untriaged finding ordinal(s) ${ordinals.join(', ')}`
        : `review ${review.reviewId}: review grading is incomplete`
    })
    throw new Error(
      `review round is not triage-complete:\n${details.join('\n')}\n` +
        `cleared by: complete the review with ${PLATFORM_SLUG} score judge`,
    )
  }

  const reviewIds = round.map(({ reviewId }) => reviewId)
  const placeholders = reviewIds.map(() => '?').join(',')
  const rows = database
    .query<
      {
        review_id: number
        ordinal: number
        lens: string
        severity: string
        triaged_severity: string | null
        disposition: 'accepted' | 'modified'
        location: string
        evidence: string
        proposed_correction: string
      },
      number[]
    >(
      `SELECT rf.review_id,rf.ordinal,rl.lens,rf.severity,rf.triaged_severity,
              rf.disposition,rf.location,rf.evidence,rf.proposed_correction
         FROM review_finding rf JOIN review_lens rl ON rl.id=rf.review_lens_id
        WHERE rf.review_id IN (${placeholders})
          AND rf.disposition IN ('accepted','modified')
        ORDER BY rf.review_id,rf.ordinal`,
    )
    .all(...reviewIds)
  if (!rows.length) {
    throw new Error(
      'the current review round has no accepted or modified findings; ' +
        'continue without --findings',
    )
  }
  return rows.map((row) => ({
    reviewId: row.review_id,
    ordinal: row.ordinal,
    lens: row.lens,
    reviewerSeverity: row.severity,
    triagedSeverity: row.triaged_severity,
    disposition: row.disposition,
    location: row.location,
    evidence: row.evidence,
    proposedCorrection: row.proposed_correction,
  }))
}

/** Pure presentation decision shared by normal and checkpoint continuation paths. */
export function renderContinuationFindings(
  findings: readonly ContinuationFinding[],
  architectMessage: string | undefined,
): string {
  if (findings.some(({ disposition }) => disposition === 'modified') && !architectMessage) {
    throw new Error(
      'a modified finding requires an architect message that states the changed correction',
    )
  }
  const items = findings.map((finding, index) => {
    const severity = finding.triagedSeverity
      ? `${finding.triagedSeverity} (triaged)`
      : `${finding.reviewerSeverity} (reviewer)`
    const modified =
      finding.disposition === 'modified'
        ? "\n   Modified: the architect message overrides the reviewer's proposed correction."
        : ''
    return (
      `${index + 1}. Review ${finding.reviewId}, finding ${finding.ordinal}\n` +
      `   Lens: ${finding.lens}\n` +
      `   Severity: ${severity}\n` +
      `   Location: ${finding.location}\n` +
      `   Evidence: ${finding.evidence}\n` +
      `   Proposed correction: ${finding.proposedCorrection}${modified}`
    )
  })
  return (
    `REVIEW FINDINGS\n\n${items.join('\n\n')}\n\n` +
    (architectMessage === undefined ? '' : `ARCHITECT MESSAGE\n\n${architectMessage}\n\n`) +
    'Apply each item and nothing else, and in the summary answer each item by its number as ' +
    'applied, or not applied and why.'
  )
}

/** Query and render a measured review round. */
export function continuationFindings(
  database: Database,
  group: ChangeGroup,
  architectMessage: string | undefined,
): string {
  return renderContinuationFindings(selectedFindings(database, group), architectMessage)
}

/** Resolve a run's current branch review round and render it for continuation. */
export function continuationFindingsForRun(
  database: Database,
  runId: number,
  architectMessage: string | undefined,
): string {
  const run = database
    .query<{ repo: string | null; branch: string | null; branch_kept: string | null }, [number]>(
      'SELECT repo,branch,branch_kept FROM run WHERE id=?',
    )
    .get(runId)
  if (!run) throw new Error(`no run ${runId}`)
  const branch = run.branch ?? run.branch_kept
  if (!run.repo || !branch) {
    throw new Error(`run ${runId} has no recorded project branch for review findings`)
  }
  const project = projectByName(run.repo, database)
  if (!project) throw new Error(`run ${runId} project ${run.repo} is not registered`)
  const tip = gitContext(project.path, 'rev-parse', '--verify', `refs/heads/${branch}^{commit}`)
  if (!tip) throw new Error(`cannot resolve the current tip of branch ${branch}`)
  const measured = measureChangeGroup(project.path, project, branch, tip)
  if (!measured) throw new Error(`could not measure the current change group for branch ${branch}`)
  return continuationFindings(database, measured.group, architectMessage)
}
