// concern: review-funnel-commands
/** Thin command services for reporting, replaying, and changing the global funnel policy. */
import type { Database } from 'bun:sqlite'
import { readFileSync } from 'node:fs'
import { db } from '../database/db.ts'
import type { ReviewFunnelFacts, ReviewFunnelVerdict } from './decide-review-funnel.ts'
import {
  activeReviewFunnelPolicy,
  parseReviewFunnelPolicy,
  type ReviewFunnelPolicy,
  reviewFunnelPolicyAt,
  setReviewFunnelPolicy,
} from './review-funnel-policy.ts'
import { replayReviewFunnelRows } from './review-funnel-replay.ts'
import {
  type FunnelReportDecisionRow,
  type FunnelReportFindingRow,
  reviewFunnelReport,
} from './review-funnel-report.ts'

type Flags = { has(name: string): boolean; flag(name: string): string | undefined }
type Presentation = { log(...values: unknown[]): void }

function decisionRows(database: Database): FunnelReportDecisionRow[] {
  return database
    .query<Record<string, unknown>, []>(
      `SELECT project.name AS project,decision.stack,decision.task_key,decision.patch_id,
            decision.path_set,decision.surface,decision.outcome,decision.verdict,decision.recorded_at
       FROM review_funnel_decision decision
       LEFT JOIN project ON project.record_id=decision.project_record_id
      ORDER BY decision.recorded_at,decision.record_id`,
    )
    .all()
    .map((row) => ({
      project: String(row.project ?? JSON.parse(String(row.verdict)).change.project),
      stack: row.stack == null ? null : String(row.stack),
      taskKey: row.task_key == null ? null : String(row.task_key),
      patchId: String(row.patch_id),
      pathSet: String(row.path_set),
      surface: String(row.surface),
      outcome: String(row.outcome) as FunnelReportDecisionRow['outcome'],
      verdict: JSON.parse(String(row.verdict)) as ReviewFunnelVerdict,
      recordedAt: String(row.recorded_at),
    }))
}

function findingRows(database: Database): FunnelReportFindingRow[] {
  return database
    .query<Record<string, unknown>, []>(
      `SELECT project.name AS project,
            (SELECT decision.stack FROM review_funnel_decision decision
              WHERE decision.project_record_id=review.project_record_id
                AND decision.patch_id=review.patch_id AND decision.path_set=review.path_set
              ORDER BY decision.recorded_at DESC LIMIT 1) AS stack,
            review.tier,review.round,
            SUM(CASE WHEN finding.disposition IN ('accepted','modified') THEN 1 ELSE 0 END) AS accepted,
            SUM(CASE WHEN finding.disposition IN ('accepted','modified')
                       AND finding.duplicate_of_finding_record_id IS NULL THEN 1 ELSE 0 END) AS unique_count
       FROM review
       JOIN project ON project.record_id=review.project_record_id
       LEFT JOIN review_finding finding ON finding.review_record_id=review.record_id
      WHERE review.tier IS NOT NULL AND review.round IS NOT NULL
      GROUP BY review.record_id,project.name,stack,review.tier,review.round`,
    )
    .all()
    .map((row) => ({
      project: String(row.project),
      stack: row.stack == null ? null : String(row.stack),
      tier: Number(row.tier),
      round: Number(row.round),
      accepted: Number(row.accepted),
      unique: Number(row.unique_count),
    }))
}

export function reportReviewFunnelCommand(flags: Flags, { log }: Presentation): void {
  const report = reviewFunnelReport(decisionRows(db()), findingRows(db()))
  if (flags.has('json')) {
    log(JSON.stringify(report))
    return
  }
  if (!report.length) {
    log('No review-funnel decisions recorded.')
    return
  }
  for (const row of report)
    log(
      `${row.project} stack=${row.stack ?? 'unknown'} disagreements=${row.tierAdmissionDisagreements} ` +
        `refusals_after_following_tier=${row.refusalsAfterFollowingTier} rounds=${JSON.stringify(row.roundsPerTier)} ` +
        `accepted=${JSON.stringify(row.acceptedFindingsPerRound)} unique=${JSON.stringify(row.uniqueFindingsPerRound)}`,
    )
}

function policyFromFlags(flags: Flags): { policy: ReviewFunnelPolicy; version: string } {
  const version = flags.flag('policy')
  const file = flags.flag('policy-file')
  if (Boolean(version) === Boolean(file))
    throw new Error('supply exactly one of --policy <version> or --policy-file <path>')
  if (file)
    return {
      policy: parseReviewFunnelPolicy(JSON.parse(readFileSync(file, 'utf8'))),
      version: `file:${file}`,
    }
  const stored = reviewFunnelPolicyAt(version!)
  return { policy: stored.policy, version: stored.policyVersion }
}

export function replayReviewFunnelCommand(flags: Flags, { log }: Presentation): void {
  const candidate = policyFromFlags(flags)
  const rows = db()
    .query<{ record_id: string; facts: string; verdict: string }, []>(
      'SELECT record_id,facts,verdict FROM review_funnel_decision ORDER BY recorded_at,record_id',
    )
    .all()
    .map((row) => ({
      recordId: row.record_id,
      facts: JSON.parse(row.facts) as ReviewFunnelFacts,
      verdict: JSON.parse(row.verdict) as ReviewFunnelVerdict,
    }))
  const diffs = replayReviewFunnelRows(rows, candidate)
  const result = {
    policyVersion: candidate.version,
    rows: db().query('SELECT count(*) AS count FROM review_funnel_decision').get() as {
      count: number
    },
    diffCount: diffs.length,
    diffs,
  }
  log(
    flags.has('json')
      ? JSON.stringify(result)
      : `Replay ${candidate.version}: ${result.rows.count} row(s), ${diffs.length} diff(s).`,
  )
}

export async function policyReviewFunnelCommand(
  flags: Flags,
  { log }: Presentation,
): Promise<void> {
  const file = flags.flag('set')
  if (!file) {
    const active = activeReviewFunnelPolicy()
    return log(JSON.stringify({ revision: active.policyVersion, policy: active.policy }, null, 2))
  }
  const policy = parseReviewFunnelPolicy(JSON.parse(readFileSync(file, 'utf8')))
  const written = await setReviewFunnelPolicy(policy)
  log(JSON.stringify({ revision: written.revision, policy }, null, 2))
}
