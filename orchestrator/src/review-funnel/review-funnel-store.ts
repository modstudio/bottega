// concern: review-funnel-store
/** Reads the local evidence rows used by review-funnel reports. */
import type { Database } from 'bun:sqlite'
import type { ReviewFunnelVerdict } from './decide-review-funnel.ts'
import type { FunnelReportDecisionRow, FunnelReportFindingRow } from './review-funnel-report.ts'

export function reviewFunnelDecisionRows(database: Database): FunnelReportDecisionRow[] {
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
      surface: String(row.surface) as FunnelReportDecisionRow['surface'],
      outcome: String(row.outcome) as FunnelReportDecisionRow['outcome'],
      verdict: JSON.parse(String(row.verdict)) as ReviewFunnelVerdict,
      recordedAt: String(row.recorded_at),
    }))
}

export function reviewFunnelFindingRows(database: Database): FunnelReportFindingRow[] {
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
