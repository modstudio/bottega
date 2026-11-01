// concern: review-outbox
/** Knows how local reviews become ordered hosted-record mutations. Must not know Postgres. */
import type { Database } from 'bun:sqlite'
import { PLATFORM_SPACE_ID } from '../../../shared/record/schema.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { nowIso } from '../database/db.ts'
import { machineId } from '../record/machine-identity.ts'
import { type OutboxSanitizeKind, sanitizeOutboxPayload } from '../record/outbox-sanitize.ts'
import { serializeOutboxPayload } from '../record/outbox-serialize.ts'

export type ReviewRecordBackfillResult = {
  enqueuedReviews: number
  enqueuedReads: number
}

const json = (value: unknown): unknown => (value == null ? null : JSON.parse(String(value)))
const enqueue = (
  database: Database,
  kind: OutboxSanitizeKind,
  recordId: string,
  value: Record<string, unknown>,
  at: string,
) => {
  database
    .query('INSERT INTO outbox (record_id, kind, row_id, payload, created_at) VALUES (?,?,?,?,?)')
    .run(
      newRecordId(),
      kind,
      recordId,
      serializeOutboxPayload(kind, sanitizeOutboxPayload(kind, value)),
      at,
    )
}

export function enqueueReview(database: Database, reviewRecordId: string): void {
  const at = nowIso()
  const machine = machineId()
  const row = database
    .query<Record<string, unknown>, [string]>(
      `SELECT review.record_id,review.number,review.recorded_at,review.completed_at,review.tier,
              review.tier_risk,review.tier_size,review.tier_insertions,review.tier_deletions,
              review.tier_reasons,review.tier_reason,review.patch_id,
              review.path_set,review.commit_message,review.outdated_at,review.outdated_reason,review.role,review.round,
              project.name AS project_name, project.record_id AS project_record_id FROM review
      LEFT JOIN project ON project.record_id=review.project_record_id WHERE review.record_id=?`,
    )
    .get(reviewRecordId)
  if (!row) throw new Error(`review ${reviewRecordId} does not exist and cannot be enqueued`)
  enqueue(
    database,
    'review',
    String(row.record_id),
    {
      id: row.record_id,
      spaceId: PLATFORM_SPACE_ID,
      projectId: row.project_record_id,
      projectName: row.project_name,
      machineId: machine,
      localId: row.number,
      recordedAt: row.recorded_at,
      completedAt: row.completed_at,
      tier: row.tier,
      tierRisk: row.tier_risk,
      tierSize: row.tier_size,
      tierInsertions: row.tier_insertions,
      tierDeletions: row.tier_deletions,
      tierReasons: json(row.tier_reasons),
      tierReason: row.tier_reason,
      role: row.role,
      round: row.round,
      patchId: row.patch_id,
      pathSet: json(row.path_set),
      commitMessage: row.commit_message,
      outdatedAt: row.outdated_at,
      outdatedReason: row.outdated_reason,
      createdAt: row.recorded_at,
      updatedAt: at,
    },
    at,
  )
  const lenses = database
    .query<{ record_id: string }, [string]>(
      'SELECT record_id FROM review_lens WHERE review_record_id=? ORDER BY record_id',
    )
    .all(reviewRecordId)
  for (const lens of lenses) enqueueReviewLens(database, lens.record_id, at, machine)
  const findings = database
    .query<{ record_id: string }, [string]>(
      'SELECT record_id FROM review_finding WHERE review_record_id=? ORDER BY ordinal',
    )
    .all(reviewRecordId)
  for (const finding of findings) enqueueReviewFinding(database, finding.record_id, at, machine)
}

export function enqueueReviewLens(
  database: Database,
  lensRecordId: string,
  at = nowIso(),
  machine = machineId(),
): void {
  const row = database
    .query<Record<string, unknown>, [string]>(
      `SELECT lens.record_id,lens.lens,lens.agent,lens.model,lens.tree_inspected,lens.reviewed_tree,
              lens.standards_read,lens.files_covered,lens.commands_run,lens.could_not_verify,
              lens.mcp_tools,lens.docs_read,lens.substitutes,lens.reproduced,lens.coverage,lens.limits,lens.overlap,lens.selection_reason,
              review.record_id AS review_record_id, run.record_id AS run_record_id,
              project.name AS project_name, project.record_id AS project_record_id
       FROM review_lens lens JOIN review ON review.record_id=lens.review_record_id
       JOIN run ON run.record_id=lens.run_record_id
       LEFT JOIN project ON project.record_id=review.project_record_id WHERE lens.record_id=?`,
    )
    .get(lensRecordId)
  if (!row) throw new Error(`review lens ${lensRecordId} does not exist and cannot be enqueued`)
  if (!row.run_record_id)
    throw new Error(`review lens ${lensRecordId} has a run without a record id`)
  enqueue(
    database,
    'review_lens',
    String(row.record_id),
    {
      id: row.record_id,
      spaceId: PLATFORM_SPACE_ID,
      projectId: row.project_record_id,
      projectName: row.project_name,
      reviewId: row.review_record_id,
      runId: row.run_record_id,
      machineId: machine,
      localId: null,
      lens: row.lens,
      agent: row.agent,
      model: row.model,
      treeInspected: row.tree_inspected,
      reviewedTree: row.reviewed_tree,
      standardsRead: json(row.standards_read),
      filesCovered: json(row.files_covered),
      commandsRun: json(row.commands_run),
      couldNotVerify: json(row.could_not_verify),
      mcpTools: json(row.mcp_tools),
      docsRead: json(row.docs_read),
      substitutes: json(row.substitutes),
      reproduced: row.reproduced,
      coverage: row.coverage,
      limits: row.limits,
      overlap: row.overlap,
      selectionReason: row.selection_reason,
      createdAt: at,
      updatedAt: at,
    },
    at,
  )
}

export function enqueueReviewFinding(
  database: Database,
  findingRecordId: string,
  at = nowIso(),
  machine = machineId(),
): void {
  const row = database
    .query<Record<string, unknown>, [string]>(
      `SELECT finding.record_id,finding.ordinal,finding.severity,finding.location,finding.evidence,
            finding.proposed_correction,finding.disposition,finding.rejection_category,
            finding.triaged_severity,finding.triaged_at,finding.duplicate_of_finding_record_id,
            review.record_id AS review_record_id,
            project.name AS project_name, project.record_id AS project_record_id,
            lens.record_id AS review_lens_record_id
       FROM review_finding finding JOIN review ON review.record_id=finding.review_record_id
       JOIN review_lens lens ON lens.record_id=finding.review_lens_record_id
       LEFT JOIN project ON project.record_id=review.project_record_id WHERE finding.record_id=?`,
    )
    .get(findingRecordId)
  if (!row)
    throw new Error(`review finding ${findingRecordId} does not exist and cannot be enqueued`)
  enqueue(
    database,
    'review_finding',
    String(row.record_id),
    {
      id: row.record_id,
      spaceId: PLATFORM_SPACE_ID,
      projectId: row.project_record_id,
      projectName: row.project_name,
      reviewId: row.review_record_id,
      reviewLensId: row.review_lens_record_id,
      machineId: machine,
      localId: null,
      ordinal: row.ordinal,
      severity: row.severity,
      location: row.location,
      evidence: row.evidence,
      proposedCorrection: row.proposed_correction,
      disposition: row.disposition,
      rejectionCategory: row.rejection_category,
      triagedSeverity: row.triaged_severity,
      triagedAt: row.triaged_at,
      duplicateOfFindingId: row.duplicate_of_finding_record_id,
      createdAt: at,
      updatedAt: at,
    },
    at,
  )
}

export function enqueueReviewRead(database: Database, readRecordId: string): void {
  const at = nowIso()
  const row = database
    .query<Record<string, unknown>, [string]>(
      `SELECT review_read.record_id,review_read.branch,review_read.tip,review_read.patch_id,
              review_read.path_set,review_read.tier,review_read.note,review_read.session_id,review_read.recorded_at,
              project.name AS project_name, project.record_id AS project_record_id FROM review_read
     LEFT JOIN project ON project.record_id=review_read.project_record_id WHERE review_read.record_id=?`,
    )
    .get(readRecordId)
  if (!row?.record_id) throw new Error(`review read ${readRecordId} does not exist`)
  enqueue(
    database,
    'review_read',
    String(row.record_id),
    {
      id: row.record_id,
      spaceId: PLATFORM_SPACE_ID,
      projectId: row.project_record_id,
      projectName: row.project_name,
      machineId: machineId(),
      localId: null,
      branch: row.branch,
      tip: row.tip,
      patchId: row.patch_id,
      pathSet: json(row.path_set),
      tier: row.tier,
      note: row.note,
      sessionId: row.session_id,
      recordedAt: row.recorded_at,
      createdAt: row.recorded_at,
      updatedAt: at,
    },
    at,
  )
}

export function backfillReviewRecords(database: Database): ReviewRecordBackfillResult {
  const reviews = database
    .query<{ record_id: string }, []>(
      `SELECT record_id FROM review WHERE NOT EXISTS
       (SELECT 1 FROM outbox WHERE kind='review' AND row_id=review.record_id) ORDER BY number`,
    )
    .all()
  const reclassified = database
    .query<{ record_id: string }, []>(
      `SELECT review.record_id FROM review
       WHERE review.role='supplementary'
         AND EXISTS (
           SELECT 1 FROM outbox WHERE outbox.kind='review' AND outbox.row_id=review.record_id
         )
         AND COALESCE((
           SELECT json_extract(outbox.payload,'$.role') FROM outbox
            WHERE outbox.kind='review' AND outbox.row_id=review.record_id
            ORDER BY outbox.id DESC LIMIT 1
         ), '')<>'supplementary'
       ORDER BY review.number`,
    )
    .all()
  for (const row of reviews) enqueueReview(database, row.record_id)
  for (const row of reclassified) enqueueReview(database, row.record_id)
  const reads = database
    .query<{ record_id: string }, []>(
      `SELECT record_id FROM review_read WHERE NOT EXISTS
     (SELECT 1 FROM outbox WHERE kind='review_read' AND row_id=review_read.record_id) ORDER BY recorded_at,record_id`,
    )
    .all()
  for (const row of reads) enqueueReviewRead(database, row.record_id)
  return {
    enqueuedReviews: reviews.length + reclassified.length,
    enqueuedReads: reads.length,
  }
}
