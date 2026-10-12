// concern: review-round-budget
/** Knows the per-tier round ceiling and measures branch use from eligible review evidence. */
import type { Database } from 'bun:sqlite'
import { reviewRunEvidenceSql } from './review-evidence-sql.ts'
import { type ReviewRoundEvidenceRow, reviewRoundIdentity } from './review-yield.ts'

export type ReviewTierNumber = 0 | 1 | 2 | 3

export type ReviewRoundBudgetDecision = {
  roundsUsed: number
  ceiling: number
  currentChangeCounted: boolean
  startsNewRound: boolean
  wouldExceedCeiling: boolean
}

/** Tier n permits n review rounds. */
export function reviewRoundBudgetDecision(input: {
  tier: ReviewTierNumber
  roundsUsed: number
  currentChangeCounted: boolean
}): ReviewRoundBudgetDecision {
  const startsNewRound = !input.currentChangeCounted
  return {
    roundsUsed: input.roundsUsed,
    ceiling: input.tier,
    currentChangeCounted: input.currentChangeCounted,
    startsNewRound,
    wouldExceedCeiling: startsNewRound && input.roundsUsed + 1 > input.tier,
  }
}

type ReviewBudgetBranch = {
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
}

function eligibleRows(database: Database, since?: string): ReviewRoundEvidenceRow[] {
  return database
    .query(
      `SELECT rl.id AS lens_id, r.id AS review_id, r.recorded_at, r.completed_at, r.tier,
              r.patch_id, r.path_set, p.name AS project, run.repo AS run_repo,
              run.launch_key, run.branch, rl.lens, rl.agent, rl.model,
              run.latency_ms, run.input_tree, run.head_commit, rl.overlap
         FROM review_lens rl
         JOIN review r ON r.id=rl.review_id
         JOIN run ON run.id=rl.run_id
         LEFT JOIN project p ON p.id=r.project_id
        WHERE ${reviewRunEvidenceSql('run', 'rl')}
          AND (? IS NULL OR r.recorded_at >= ?)
        ORDER BY r.recorded_at,r.id,rl.id`,
    )
    .all(since ?? null, since ?? null) as ReviewRoundEvidenceRow[]
}

function branchEvidence(database: Database, since?: string): Map<string, BranchEvidence> {
  const branches = new Map<string, BranchEvidence>()
  for (const row of eligibleRows(database, since)) {
    if (!row.branch) continue
    const branch = branches.get(row.branch) ?? {
      firstReviewAt: row.recorded_at,
      tier: null,
      rounds: new Map<string, string>(),
    }
    if (row.tier !== null && (branch.tier === null || row.tier > branch.tier)) {
      branch.tier = row.tier
    }
    const round = reviewRoundIdentity(row).identity
    if (round && !branch.rounds.has(round)) branch.rounds.set(round, row.recorded_at)
    branches.set(row.branch, branch)
  }
  return branches
}

export function reviewBudgetForBranch(
  database: Database,
  branch: string,
  currentRoundIdentity: string | null,
): { roundsUsed: number; currentChangeCounted: boolean } {
  const evidence = branchEvidence(database).get(branch)
  return {
    roundsUsed: evidence?.rounds.size ?? 0,
    currentChangeCounted: Boolean(
      currentRoundIdentity && evidence?.rounds.has(currentRoundIdentity),
    ),
  }
}

export function reviewBudgetReport(database: Database, since?: string): ReviewBudgetReport {
  const evidence = branchEvidence(database, since)
  const classified = [...evidence.entries()].filter(
    (entry): entry is [string, BranchEvidence & { tier: ReviewTierNumber }] =>
      entry[1].tier !== null,
  )
  const over = classified
    .flatMap(([branch, row]) => {
      if (row.rounds.size <= row.tier) return []
      const roundTimes = [...row.rounds.values()].sort()
      return [
        {
          branch,
          tier: row.tier,
          rounds: row.rounds.size,
          firstReviewAt: row.firstReviewAt,
          exceededAt: roundTimes[row.tier]!,
        },
      ]
    })
    .sort((a, b) => a.exceededAt.localeCompare(b.exceededAt) || a.branch.localeCompare(b.branch))
  const rows = [...evidence.values()]
  return {
    since: since ?? null,
    branches: over,
    denominators: {
      eligibleReviewBranches: rows.length,
      withRecordedTier: classified.length,
      withClassifiableRound: rows.filter((row) => row.rounds.size > 0).length,
      exactlyAtCeiling: classified.filter(([, row]) => row.rounds.size === row.tier).length,
      overCeiling: over.length,
      withoutRecordedTier: rows.filter((row) => row.tier === null).length,
      withoutClassifiableRound: rows.filter((row) => row.rounds.size === 0).length,
    },
  }
}

export function renderReviewBudgetHuman(report: ReviewBudgetReport): string {
  const lines = ['BRANCH  TIER  ROUNDS  FIRST REVIEW  CEILING CROSSED']
  if (!report.branches.length) lines.push('(none)')
  for (const row of report.branches) {
    lines.push(`${row.branch}  ${row.tier}  ${row.rounds}  ${row.firstReviewAt}  ${row.exceededAt}`)
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
