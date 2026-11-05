// concern: record-change-feed
/** Reads record changes and materializes each served family with its existing keyset serializer. */
import type { SQL } from 'bun'
import { bindTenant, type TenantPrincipal } from '../../../shared/record/tenant.ts'
import {
  readRecordChangesInTransaction,
  type RecordChangeCursor,
  type RecordChangeEntry,
} from '../../../shared/record/record-changes.ts'
import { RECORD_LENS_TABLES, type RecordLensTable } from './record-lens-contract.ts'
import { RECORD_PORT_TABLES, type RecordPortTable } from './record-port-contract.ts'
import { RECORD_WORKFLOW_TABLES, type RecordWorkflowTable } from './record-workflow-contract.ts'
import { recordDocRow } from './record-doc-mapping.ts'
import { mapRecordLensRow, selectionRevisionRows, selectionRows } from './record-lens-catalogue.ts'
import { mapRecordPortRow } from './record-port-catalogue.ts'
import { mapRecordProjectRow } from './record-projects.ts'
import { recordPool } from './record-pool.ts'
import { mapRecordRoutingEvidenceRow, ROUTING_EVIDENCE_RUN_FIELDS, ROUTING_EVIDENCE_SCORE_FIELDS } from './record-routing-evidence.ts'
import { mapRecordSubjectRow } from './record-subjects.ts'
import { mapRecordScoreRow } from './record-verdicts.ts'
import { mapRecordWorkflowRow } from './record-workflow-catalogue.ts'

export const RECORD_CHANGE_SERVED_TABLES = [
  'doc', 'subject', 'project', ...RECORD_LENS_TABLES, ...RECORD_PORT_TABLES,
  ...RECORD_WORKFLOW_TABLES, 'run_score', 'routing_evidence',
] as const
export type RecordChangeServedTable = (typeof RECORD_CHANGE_SERVED_TABLES)[number]
const RECORD_CHANGE_LOG_TABLES = [
  ...RECORD_CHANGE_SERVED_TABLES.filter((table) => table !== 'routing_evidence'),
  'run', 'review',
] as const

type MaterializedChange = {
  table: RecordChangeServedTable
  id: string
  space: string
  op: 'upsert' | 'delete'
  row?: unknown
}
type FamilyKey = Omit<MaterializedChange, 'row'> & { position: number }
const records = (value: unknown) => value as Record<string, unknown>[]

function familyKeys(changes: readonly RecordChangeEntry[]): FamilyKey[] {
  const keyed: FamilyKey[] = []
  for (const [position, change] of changes.entries()) {
    if (change.table === 'run')
      keyed.push({ table: 'routing_evidence', id: change.id, space: change.space, op: change.op, position })
    else if (change.table === 'review')
      keyed.push({ table: 'routing_evidence', id: change.id, space: change.space, op: 'upsert', position })
    else if (change.table === 'run_score') {
      keyed.push({ table: 'run_score', id: change.id, space: change.space, op: change.op, position })
      keyed.push({ table: 'routing_evidence', id: change.id, space: change.space, op: 'upsert', position })
    } else if ((RECORD_CHANGE_SERVED_TABLES as readonly string[]).includes(change.table))
      keyed.push({ table: change.table as RecordChangeServedTable, id: change.id, space: change.space, op: change.op, position })
  }
  const last = new Map<string, FamilyKey>()
  for (const item of keyed) last.set(`${item.table}:${item.id}`, item)
  return [...last.values()].sort((a, b) => a.position - b.position)
}

async function reviewRunIds(tx: SQL, changes: readonly RecordChangeEntry[]) {
  const ids = changes.filter((change) => change.table === 'review').map((change) => change.id)
  if (!ids.length) return new Map<string, string>()
  const rows = records(await tx`SELECT id::text,run_id::text FROM review WHERE id=ANY(${tx.array(ids, 'uuid')})`)
  return new Map(rows.map((row) => [String(row.id), String(row.run_id)]))
}

async function normalizedKeys(tx: SQL, changes: readonly RecordChangeEntry[]) {
  const reviewRuns = await reviewRunIds(tx, changes)
  return familyKeys(changes.map((change) => change.table === 'review' && reviewRuns.has(change.id)
    ? { ...change, id: reviewRuns.get(change.id)! } : change))
}

async function rowFor(tx: SQL, key: FamilyKey): Promise<unknown | undefined> {
  if (key.op === 'delete' && key.table !== 'routing_evidence') return undefined
  const id = key.id
  if (key.table === 'doc') {
    const rows = records(await tx`SELECT d.*,s.name AS space_name,p.name AS project_name,
      own.name AS article_subject_name,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('id',rs.id,'name',rs.name) ORDER BY rs.position,rs.id)
        FROM doc_related_subject dr JOIN subject rs ON rs.id=dr.subject_id
        WHERE dr.space_id=d.space_id AND dr.doc_id=d.id),'[]'::jsonb) AS related_subjects
      FROM doc d JOIN space s ON s.id=d.space_id LEFT JOIN project p ON p.id=d.project_id
      LEFT JOIN subject own ON own.id=d.article_subject_id WHERE d.id=${id}::uuid`)
    return rows[0] ? recordDocRow(rows[0]) : undefined
  }
  if (key.table === 'project') {
    const rows = records(await tx`SELECT p.*,s.name AS space_name FROM project p JOIN space s ON s.id=p.space_id WHERE p.id=${id}::uuid`)
    return rows[0] ? mapRecordProjectRow(rows[0]) : undefined
  }
  if (key.table === 'subject') {
    const rows = records(await tx`SELECT s.*,p.name AS project FROM subject s JOIN project p ON p.id=s.project_id AND p.space_id=s.space_id WHERE s.id=${id}::uuid`)
    return rows[0] ? mapRecordSubjectRow(rows[0]) : undefined
  }
  if ((RECORD_LENS_TABLES as readonly string[]).includes(key.table)) {
    const table = key.table as RecordLensTable
    let rows: Record<string, unknown>[]
    if (table === 'project_lens_profile') rows = await selectionRows(tx, key.space, { at: null, id: null, rowId: id, limit: 1 })
    else if (table === 'project_lens_profile_revision') rows = await selectionRevisionRows(tx, key.space, { at: null, id: null, rowId: id, limit: 1 })
    else rows = records(await tx.unsafe(`SELECT * FROM ${table} WHERE id=$1::uuid`, [id]))
    return rows[0] ? mapRecordLensRow(table, rows[0]) : undefined
  }
  if ((RECORD_PORT_TABLES as readonly string[]).includes(key.table)) {
    const table = key.table as RecordPortTable
    const rows = records(await tx.unsafe(`SELECT * FROM ${table} WHERE id=$1::uuid`, [id]))
    return rows[0] ? mapRecordPortRow(table, rows[0]) : undefined
  }
  if ((RECORD_WORKFLOW_TABLES as readonly string[]).includes(key.table)) {
    const table = key.table as RecordWorkflowTable
    const rows = records(await tx.unsafe(`SELECT * FROM ${table} WHERE id=$1::uuid`, [id]))
    return rows[0] ? mapRecordWorkflowRow(table, rows[0]) : undefined
  }
  if (key.table === 'run_score') {
    const rows = records(await tx`SELECT COALESCE(s.run_id,e.run_id) AS run_id,s.delivery,s.quality,s.fidelity,s.note,s.scored_at,s.scored_by,
      GREATEST(s.updated_at,e.excluded_at,e.superseded_at) AS updated_at,
      CASE WHEN e.superseded_at IS NOT NULL THEN NULL ELSE COALESCE(r.evidence_excluded,e.reason) END AS evidence_excluded
      FROM run_score s FULL OUTER JOIN run_exclusion e ON e.run_id=s.run_id AND e.space_id=s.space_id
      LEFT JOIN run r ON r.id=COALESCE(s.run_id,e.run_id) WHERE COALESCE(s.run_id,e.run_id)=${id}::uuid`)
    return rows[0] ? mapRecordScoreRow(rows[0]) : undefined
  }
  const rows = records(await tx`SELECT r.id,r.space_id,r.agent,r.model,r.job,r.stack,r.prompt_bytes,r.status,r.failure_kind,
    COALESCE(r.executor,'external') AS executor,r.evidence_excluded,r.started_at,r.latency_ms,r.vendor_tokens,r.model_calls,
    r.peak_call_tokens,s.delivery,s.quality,s.fidelity,r.evidence_seq,
    COALESCE((SELECT array_agg(DISTINCT lens.lens ORDER BY lens.lens) FROM review_lens lens WHERE lens.run_id=r.id),ARRAY[]::text[]) AS lenses
    FROM run r LEFT JOIN run_score s ON s.run_id=r.id AND s.space_id=r.space_id
    WHERE r.id=${id}::uuid AND r.probe=false AND r.parent_run_id IS NULL AND r.status IN ('ok','failed','stale')
      AND NOT (COALESCE(r.withheld_fields,'[]'::jsonb) ?| ${tx.array([...ROUTING_EVIDENCE_RUN_FIELDS], 'text')})
      AND (s.run_id IS NULL OR NOT (COALESCE(s.withheld_fields,'[]'::jsonb) ?| ${tx.array([...ROUTING_EVIDENCE_SCORE_FIELDS], 'text')}))
      AND NOT EXISTS (SELECT 1 FROM review_lens withheld WHERE withheld.run_id=r.id AND COALESCE(withheld.withheld_fields,'[]'::jsonb) ? 'lens')`)
  return rows[0] ? mapRecordRoutingEvidenceRow(rows[0]) : undefined
}

export async function readRecordChangeFeed(
  input: { url: string } & TenantPrincipal & { after: RecordChangeCursor | null; limit: number },
) {
  return recordPool(input.url).begin(async (tx) => {
    await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`
    await bindTenant(tx, input)
    const page = await readRecordChangesInTransaction(tx, input.after, input.limit, RECORD_CHANGE_LOG_TABLES)
    if (page.resetRequired) return page
    const keys = await normalizedKeys(tx, page.changes)
    const changes: MaterializedChange[] = []
    for (const key of keys) {
      const row = await rowFor(tx, key)
      const base = { table: key.table, id: key.id, space: key.space, op: row ? 'upsert' as const : 'delete' as const }
      changes.push(row === undefined ? base : { ...base, row })
    }
    return { ...page, changes }
  })
}
