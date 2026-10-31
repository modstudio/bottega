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
  serializePathSet,
  type TriageReviewRow,
} from './review-group.ts'

export type ContinuationFinding = {
  reviewNumber: number
  ordinal: number
  lens: string
  reviewerSeverity: string
  triagedSeverity: string | null
  disposition: 'accepted' | 'modified'
  location: string
  evidence: string
  proposedCorrection: string
}

export type ContinuationFindingsStaleness = {
  reviewedSha: string | null
  commitLines: readonly string[]
}

type SelectedContinuationRound = {
  reviews: TriageReviewRow[]
  matchesCurrentGroup: boolean
}

/** Choose the newest review round on the branch lineage, independent of today's patch. */
function selectContinuationReviewRound(
  branchReviews: readonly TriageReviewRow[],
  group: ChangeGroup,
): SelectedContinuationRound {
  const newest = branchReviews[0]
  if (!newest) {
    throw new Error(
      `the review lineage for branch ${group.branch} has no review rounds\n` +
        'cleared by: run and judge the review lenses for the current change',
    )
  }
  const reviews = branchReviews.filter(
    (review) => review.patchId === newest.patchId && review.pathSet === newest.pathSet,
  )
  return {
    reviews,
    matchesCurrentGroup:
      newest.patchId === group.patchId && newest.pathSet === serializePathSet(group.pathSet),
  }
}

function selectedFindings(
  database: Database,
  group: ChangeGroup,
): { findings: ContinuationFinding[]; round: SelectedContinuationRound } {
  const round = selectContinuationReviewRound(
    reviewsForTriage(database, group).branchReviews,
    group,
  )
  const reviews = round.reviews
  const incomplete = reviews.filter((review) => !reviewRoundTriageComplete(review))
  if (incomplete.length) {
    const details = incomplete.map((review) => {
      const ordinals = review.findings
        .filter(({ disposition }) => disposition === null)
        .map(({ ordinal }) => ordinal)
      return ordinals.length
        ? `review ${review.reviewNumber}: untriaged finding ordinal(s) ${ordinals.join(', ')}`
        : `review ${review.reviewNumber}: review grading is incomplete`
    })
    throw new Error(
      `review round is not triage-complete:\n${details.join('\n')}\n` +
        `cleared by: complete the review with ${PLATFORM_SLUG} score`,
    )
  }

  const reviewIds = reviews.map(({ reviewRecordId }) => reviewRecordId)
  const placeholders = reviewIds.map(() => '?').join(',')
  const rows = database
    .query<
      {
        review_record_id: string
        review_number: number
        ordinal: number
        lens: string
        severity: string
        triaged_severity: string | null
        disposition: 'accepted' | 'modified'
        location: string
        evidence: string
        proposed_correction: string
      },
      string[]
    >(
      `SELECT rf.review_record_id,review.number AS review_number,rf.ordinal,rl.lens,rf.severity,rf.triaged_severity,
              rf.disposition,rf.location,rf.evidence,rf.proposed_correction
         FROM review_finding rf JOIN review_lens rl ON rl.record_id=rf.review_lens_record_id
         JOIN review ON review.record_id=rf.review_record_id
        WHERE rf.review_record_id IN (${placeholders})
          AND rf.disposition IN ('accepted','modified')
        ORDER BY rf.review_record_id,rf.ordinal`,
    )
    .all(...reviewIds)
  if (!rows.length) {
    throw new Error(
      'the current review round has no accepted or modified findings; ' +
        'continue without --findings',
    )
  }
  return {
    round,
    findings: rows.map((row) => ({
      reviewNumber: row.review_number,
      ordinal: row.ordinal,
      lens: row.lens,
      reviewerSeverity: row.severity,
      triagedSeverity: row.triaged_severity,
      disposition: row.disposition,
      location: row.location,
      evidence: row.evidence,
      proposedCorrection: row.proposed_correction,
    })),
  }
}

/** Pure presentation decision shared by normal and checkpoint continuation paths. */
export function renderContinuationFindings(
  findings: readonly ContinuationFinding[],
  architectMessage: string | undefined,
  staleness?: ContinuationFindingsStaleness,
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
      `${index + 1}. Finding ${finding.reviewNumber}/${finding.ordinal}\n` +
      `   Lens: ${finding.lens}\n` +
      `   Severity: ${severity}\n` +
      `   Location: ${finding.location}\n` +
      `   Evidence: ${finding.evidence}\n` +
      `   Proposed correction: ${finding.proposedCorrection}${modified}`
    )
  })
  const stalenessParagraph = staleness
    ? staleness.reviewedSha && staleness.commitLines.length
      ? `These findings were reviewed at ${staleness.reviewedSha.slice(0, 7)}. The branch has moved since by:\n${staleness.commitLines.join('\n')}\n\n`
      : 'The reviewed commit is unknown. The branch has moved since that review.\n\n'
    : ''
  return (
    `REVIEW FINDINGS\n\n${stalenessParagraph}${items.join('\n\n')}\n\n` +
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
  staleness?: ContinuationFindingsStaleness,
): string {
  const selected = selectedFindings(database, group)
  return renderContinuationFindings(
    selected.findings,
    architectMessage,
    selected.round.matchesCurrentGroup
      ? undefined
      : (staleness ?? { reviewedSha: null, commitLines: [] }),
  )
}

function reviewedHeadCommit(
  database: Database,
  reviews: readonly TriageReviewRow[],
): string | null {
  const reviewIds = reviews.map(({ reviewRecordId }) => reviewRecordId)
  const placeholders = reviewIds.map(() => '?').join(',')
  return (
    database
      .query<{ head_commit: string }, string[]>(
        `SELECT run.head_commit FROM review_lens rl JOIN run ON run.record_id=rl.run_record_id
          WHERE rl.review_record_id IN (${placeholders}) AND run.head_commit IS NOT NULL
          ORDER BY run.number DESC LIMIT 1`,
      )
      .get(...reviewIds)?.head_commit ?? null
  )
}

/** Resolve a run's current branch review round and render it for continuation. */
export function continuationFindingsForRun(
  database: Database,
  runId: string,
  architectMessage: string | undefined,
): string {
  const run = database
    .query<{ repo: string | null; branch: string | null; branch_kept: string | null }, [string]>(
      'SELECT repo,branch,branch_kept FROM run WHERE record_id=?',
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
  const selected = selectContinuationReviewRound(
    reviewsForTriage(database, measured.group).branchReviews,
    measured.group,
  )
  let staleness: ContinuationFindingsStaleness | undefined
  if (!selected.matchesCurrentGroup) {
    const reviewedSha = reviewedHeadCommit(database, selected.reviews)
    const log = reviewedSha
      ? gitContext(project.path, 'log', '--format=%h %s', `${reviewedSha}..${tip}`)
      : null
    staleness = {
      reviewedSha: log ? reviewedSha : null,
      commitLines: log ? log.split('\n') : [],
    }
  }
  return continuationFindings(database, measured.group, architectMessage, staleness)
}
