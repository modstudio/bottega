// concern: review-outbox
/** Knows how local reviews become ordered hosted-record mutations. Must not know Postgres. */
import type { Database } from 'bun:sqlite'
import { PLATFORM_SPACE_ID } from '../../../shared/record/schema.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { nowIso } from '../database/db.ts'
import { machineId } from '../record/machine-identity.ts'

import { type OutboxSanitizeKind, stringifyOutboxPayload } from '../record/outbox-sanitize.ts'

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
    .run(newRecordId(), kind, recordId, stringifyOutboxPayload(kind, value), at)
}

export function enqueueReview(database: Database, reviewId: number): void {
  const at = nowIso()
  const machine = machineId()
  const row = database
    .query<Record<string, unknown>, [number]>(
      `SELECT review.*, project.name AS project_name FROM review
      LEFT JOIN project ON project.id=review.project_id WHERE review.id=?`,
    )
    .get(reviewId)
  if (!row) throw new Error(`review ${reviewId} does not exist and cannot be enqueued`)
  enqueue(
    database,
    'review',
    String(row.record_id),
    {
      id: row.record_id,
      spaceId: PLATFORM_SPACE_ID,
      projectName: row.project_name,
      machineId: machine,
      localId: row.id,
      recordedAt: row.recorded_at,
      completedAt: row.completed_at,
      tier: row.tier,
      tierRisk: row.tier_risk,
      tierSize: row.tier_size,
      tierReasons: json(row.tier_reasons),
      tierReason: row.tier_reason,
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
    .query<{ id: number }, [number]>('SELECT id FROM review_lens WHERE review_id=? ORDER BY id')
    .all(reviewId)
  for (const lens of lenses) enqueueReviewLens(database, lens.id, at, machine)
  const findings = database
    .query<{ id: number }, [number]>('SELECT id FROM review_finding WHERE review_id=? ORDER BY id')
    .all(reviewId)
  for (const finding of findings) enqueueReviewFinding(database, finding.id, at, machine)
}

export function enqueueReviewLens(
  database: Database,
  lensId: number,
  at = nowIso(),
  machine = machineId(),
): void {
  const row = database
    .query<Record<string, unknown>, [number]>(
      `SELECT lens.*, review.record_id AS review_record_id, run.record_id AS run_record_id,
              project.name AS project_name
       FROM review_lens lens JOIN review ON review.id=lens.review_id
       JOIN run ON run.id=lens.run_id
       LEFT JOIN project ON project.id=review.project_id WHERE lens.id=?`,
    )
    .get(lensId)
  if (!row) throw new Error(`review lens ${lensId} does not exist and cannot be enqueued`)
  if (!row.run_record_id) throw new Error(`review lens ${lensId} has a run without a record id`)
  enqueue(
    database,
    'review_lens',
    String(row.record_id),
    {
      id: row.record_id,
      spaceId: PLATFORM_SPACE_ID,
      projectName: row.project_name,
      reviewId: row.review_record_id,
      runId: row.run_record_id,
      machineId: machine,
      localId: row.id,
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
      createdAt: at,
      updatedAt: at,
    },
    at,
  )
}

export function enqueueReviewFinding(
  database: Database,
  findingId: number,
  at = nowIso(),
  machine = machineId(),
): void {
  const row = database
    .query<Record<string, unknown>, [number]>(
      `SELECT finding.*, review.record_id AS review_record_id,
            project.name AS project_name,
            lens.record_id AS review_lens_record_id
       FROM review_finding finding JOIN review ON review.id=finding.review_id
       JOIN review_lens lens ON lens.id=finding.review_lens_id
       LEFT JOIN project ON project.id=review.project_id WHERE finding.id=?`,
    )
    .get(findingId)
  if (!row) throw new Error(`review finding ${findingId} does not exist and cannot be enqueued`)
  enqueue(
    database,
    'review_finding',
    String(row.record_id),
    {
      id: row.record_id,
      spaceId: PLATFORM_SPACE_ID,
      projectName: row.project_name,
      reviewId: row.review_record_id,
      reviewLensId: row.review_lens_record_id,
      machineId: machine,
      localId: row.id,
      ordinal: row.ordinal,
      severity: row.severity,
      location: row.location,
      evidence: row.evidence,
      proposedCorrection: row.proposed_correction,
      disposition: row.disposition,
      rejectionCategory: row.rejection_category,
      triagedSeverity: row.triaged_severity,
      triagedAt: row.triaged_at,
      createdAt: at,
      updatedAt: at,
    },
    at,
  )
}

export function enqueueReviewRead(database: Database, readId: number): void {
  const at = nowIso()
  const row = database
    .query<Record<string, unknown>, [number]>(
      `SELECT review_read.*, project.name AS project_name FROM review_read
     LEFT JOIN project ON project.id=review_read.project_id WHERE review_read.id=?`,
    )
    .get(readId)
  if (!row?.record_id) throw new Error(`review read ${readId} does not exist or has no record id`)
  enqueue(
    database,
    'review_read',
    String(row.record_id),
    {
      id: row.record_id,
      spaceId: PLATFORM_SPACE_ID,
      projectName: row.project_name,
      machineId: machineId(),
      localId: row.id,
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
    .query<{ id: number }, []>(
      `SELECT id FROM review WHERE NOT EXISTS
       (SELECT 1 FROM outbox WHERE kind='review' AND row_id=review.record_id) ORDER BY id`,
    )
    .all()
  for (const row of reviews) enqueueReview(database, row.id)
  const reads = database
    .query<{ id: number }, []>(
      `SELECT id FROM review_read WHERE NOT EXISTS
     (SELECT 1 FROM outbox WHERE kind='review_read' AND row_id=review_read.record_id) ORDER BY id`,
    )
    .all()
  for (const row of reads) enqueueReviewRead(database, row.id)
  return {
    enqueuedReviews: reviews.length,
    enqueuedReads: reads.length,
  }
}
