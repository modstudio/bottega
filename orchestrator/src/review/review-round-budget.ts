// concern: review-round-budget
/** Knows the per-tier round ceiling and measures branch use from eligible review evidence. */
import { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { DB_PATH } from '../database/db.ts'
import { admissionReviewRunEvidenceSql } from './review-evidence-sql.ts'
import { provenanceSubjectFacts } from './review-group.ts'
import { lensProvenanceSubject } from './review-lens-provenance.ts'
import { reviewLineage } from './review-lineage-store.ts'
import { reviewCountsAsRound } from './review-role.ts'
import { reviewRoundIdentity } from './review-round-identity.ts'
import type { ReviewRoundEvidenceRow } from './review-yield.ts'
export type ReviewTierNumber = 0 | 1 | 2 | 3

export type ReviewRoundBudgetDecision = {
  roundsUsed: number
  ceiling: number
  currentChangeCounted: boolean
  atCeiling: boolean
  startsNewRound: boolean
  wouldExceedCeiling: boolean
}

/** Build the canonical round identity for one measured branch change. */
export function currentReviewRoundIdentity(input: {
  branch: string
  patchId: string
  pathSet: string
}): string | null {
  return reviewRoundIdentity({
    launch_key: null,
    branch: input.branch,
    patch_id: input.patchId,
    path_set: input.pathSet,
  }).identity
}

/** Tier n permits n review rounds. */
export function reviewRoundBudgetDecision(input: {
  tier: ReviewTierNumber
  roundsUsed: number
  currentChangeCounted: boolean
  roundNeeded?: boolean
}): ReviewRoundBudgetDecision {
  const startsNewRound = (input.roundNeeded ?? true) && !input.currentChangeCounted
  return {
    roundsUsed: input.roundsUsed,
    ceiling: input.tier,
    currentChangeCounted: input.currentChangeCounted,
    atCeiling: input.roundsUsed >= input.tier,
    startsNewRound,
    wouldExceedCeiling: startsNewRound && input.roundsUsed + 1 > input.tier,
  }
}

type ReviewBudgetBranch = {
  project: string | null
  branch: string
  tier: ReviewTierNumber
  rounds: number
  firstReviewAt: string
  exceededAt: string
}

export type ReviewBudgetReport = {
  since: string | null
  branches: ReviewBudgetBranch[]
  denominators: {
    eligibleReviewBranches: number
    withRecordedTier: number
    withClassifiableRound: number
    exactlyAtCeiling: number
    overCeiling: number
    withoutRecordedTier: number
    withoutClassifiableRound: number
  }
}

type BranchEvidence = {
  firstReviewAt: string
  tier: ReviewTierNumber | null
  rounds: Map<string, string>
  eligibleReviews: Set<string>
  unclassifiableReviews: Set<string>
}

type ReviewBudgetEvidenceRow = ReviewRoundEvidenceRow
export type ReviewBudgetProvenanceRow = ReviewBudgetEvidenceRow & {
  review_provenance: string | null
  worktree: string | null
  cwd: string | null
}

export type ReviewBudgetEvidence = {
  rows: ReviewBudgetProvenanceRow[]
  rounds: Map<string, string>
  eligibleReviews: Set<string>
  unclassifiableReviews: Set<string>
}

/** Apply the one admissibility and round-identity rule used by funnel and reporting. */
export function aggregateReviewBudgetEvidence(
  candidates: readonly ReviewBudgetProvenanceRow[],
): ReviewBudgetEvidence {
  const rows = candidates.filter(
    (row) => lensProvenanceSubject(provenanceSubjectFacts(row)).admissible,
  )
  const rounds = new Map<string, string>()
  const eligibleReviews = new Set<string>()
  const unclassifiableReviews = new Set<string>()
  for (const row of rows) {
    eligibleReviews.add(row.review_record_id)
    const round = reviewRoundIdentity(row).identity
    if (round) rounds.set(round, rounds.get(round) ?? row.recorded_at)
    else unclassifiableReviews.add(row.review_record_id)
  }
  return { rows, rounds, eligibleReviews, unclassifiableReviews }
}

export function eligibleReviewRoundRows(
  database: Database,
  since?: string,
  target?: { project: string; branch: string },
): ReviewBudgetProvenanceRow[] {
  const lineage = target ? reviewLineage(database, target.project, target.branch) : []
  const targetFilter = target
    ? `AND run.project_record_id=(SELECT record_id FROM project WHERE name=?)
       AND run.branch IN (${lineage.map(() => '?').join(',')})`
    : ''
  const rows = database
    .query(
      `SELECT rl.record_id AS lens_id, r.record_id AS review_record_id, r.recorded_at, r.completed_at, r.tier,
              r.patch_id, r.path_set, r.role, p.name AS project,
              run.repo AS run_repo,
              run.launch_key, run.branch, rl.lens, rl.agent, rl.model,
              run.latency_ms, run.input_tree, run.head_commit, run.review_provenance,
              run.worktree, run.cwd, rl.overlap
         FROM review_lens rl
         JOIN review r ON r.record_id=rl.review_record_id
         JOIN run ON run.record_id=rl.run_record_id
         LEFT JOIN project p ON p.record_id=r.project_record_id
        WHERE ${admissionReviewRunEvidenceSql('run', 'rl')}
          AND (? IS NULL OR r.recorded_at >= ?)
          ${targetFilter}
        ORDER BY r.recorded_at,r.number,run.number`,
    )
    .all(
      since ?? null,
      since ?? null,
      ...(target ? [target.project, ...lineage] : []),
    ) as ReviewBudgetProvenanceRow[]
  return rows.filter((row) => reviewCountsAsRound(row.role))
}

const branchKey = (project: string | null, branch: string): string =>
  JSON.stringify([project, branch])

function lineageRoot(
  database: Database,
  roots: Map<string, string>,
  project: string | null,
  branch: string,
): string {
  const key = branchKey(project, branch)
  const cached = roots.get(key)
  if (cached) return cached
  const root = project ? (reviewLineage(database, project, branch).at(-1) ?? branch) : branch
  roots.set(key, root)
  return root
}

function reviewBudgetReportEvidence(
  database: Database,
  since?: string,
): Map<string, BranchEvidence> {
  const branches = new Map<string, BranchEvidence>()
  const lineageRoots = new Map<string, string>()
  const grouped = new Map<string, ReviewBudgetProvenanceRow[]>()
  for (const row of eligibleReviewRoundRows(database, since)) {
    if (!row.branch) continue
    const evidenceBranch = lineageRoot(database, lineageRoots, row.run_repo, row.branch)
    const key = branchKey(row.run_repo, evidenceBranch)
    grouped.set(key, [...(grouped.get(key) ?? []), row])
  }
  for (const [key, candidates] of grouped) {
    const evidence = aggregateReviewBudgetEvidence(candidates)
    const first = evidence.rows[0]
    if (!first) continue
    branches.set(key, {
      firstReviewAt: first.recorded_at,
      tier: evidence.rows.reduce<ReviewTierNumber | null>(
        (tier, row) => (row.tier !== null && (tier === null || row.tier > tier) ? row.tier : tier),
        null,
      ),
      rounds: evidence.rounds,
      eligibleReviews: evidence.eligibleReviews,
      unclassifiableReviews: evidence.unclassifiableReviews,
    })
  }
  return branches
}

export function reviewBudgetReport(database: Database, since?: string): ReviewBudgetReport {
  const evidence = reviewBudgetReportEvidence(database, since)
  const classified = [...evidence.entries()].filter(
    (entry): entry is [string, BranchEvidence & { tier: ReviewTierNumber }] =>
      entry[1].tier !== null,
  )
  const over = classified
    .flatMap(([key, row]) => {
      if (row.rounds.size <= row.tier) return []
      const roundTimes = [...row.rounds.values()].sort()
      const [project, branch] = JSON.parse(key) as [string | null, string]
      return [
        {
          project,
          branch,
          tier: row.tier,
          rounds: row.rounds.size,
          firstReviewAt: row.firstReviewAt,
          exceededAt: roundTimes[row.tier]!,
        },
      ]
    })
    .sort(
      (a, b) =>
        a.exceededAt.localeCompare(b.exceededAt) ||
        (a.project ?? '').localeCompare(b.project ?? '') ||
        a.branch.localeCompare(b.branch),
    )
  const rows = [...evidence.values()]
  return {
    since: since ?? null,
    branches: over,
    denominators: {
      eligibleReviewBranches: rows.length,
      withRecordedTier: classified.length,
      withClassifiableRound: rows.filter((row) => row.rounds.size > 0).length,
      exactlyAtCeiling: classified.filter(
        ([, row]) => row.rounds.size > 0 && row.rounds.size === row.tier,
      ).length,
      overCeiling: over.length,
      withoutRecordedTier: rows.filter((row) => row.tier === null).length,
      withoutClassifiableRound: rows.filter((row) => row.rounds.size === 0).length,
    },
  }
}

function renderReviewBudgetHuman(report: ReviewBudgetReport): string {
  const lines = ['PROJECT  BRANCH  TIER  ROUNDS  FIRST REVIEW  CEILING CROSSED']
  if (!report.branches.length) lines.push('(none)')
  for (const row of report.branches) {
    lines.push(
      `${row.project ?? '—'}  ${row.branch}  ${row.tier}  ${row.rounds}  ${row.firstReviewAt}  ${row.exceededAt}`,
    )
  }
  const d = report.denominators
  lines.push(
    '',
    `branches with eligible reviews: ${d.eligibleReviewBranches}`,
    `branches with a recorded tier: ${d.withRecordedTier}`,
    `branches with a classifiable round: ${d.withClassifiableRound}`,
    `branches exactly at their ceiling: ${d.exactlyAtCeiling}`,
    `branches over their ceiling: ${d.overCeiling}`,
    `branches without a recorded tier: ${d.withoutRecordedTier}`,
    `branches without a classifiable round: ${d.withoutClassifiableRound}`,
  )
  return lines.join('\n')
}

type Flags = { has(name: string): boolean; flag(name: string): string | undefined }
type Presentation = { log(...values: unknown[]): void }

export function reviewBudgetCommand(
  argv: string[],
  flags: Flags,
  presentation: Presentation,
): void {
  if (argv.length !== 2)
    throw new Error(`${PLATFORM_SLUG} review budget [--since <ISO date>] [--json]`)
  const since = flags.flag('since')
  if (since && !Number.isFinite(Date.parse(since))) throw new Error('--since must be an ISO date')
  const database = new Database(DB_PATH, { readonly: true })
  try {
    const report = reviewBudgetReport(database, since)
    presentation.log(flags.has('json') ? JSON.stringify(report) : renderReviewBudgetHuman(report))
  } finally {
    database.close()
  }
}
