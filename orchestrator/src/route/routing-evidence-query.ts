// concern: routing-evidence-query
/** Reads only the current-model evidence window consumed by routing. */
import { db } from '../database/db.ts'
import { NOT_EVIDENCE, NOT_EVIDENCE_SQL } from '../failure/failure.ts'
import { promptBucketSql } from './prompt-size-bucket.ts'
import { weightCase } from './route-selection.ts'
import { POOL_ROUTING_EVIDENCE_ROWS_SQL, poolScopeParams } from './routing-pool-evidence.ts'

export type RoutingEvidenceRow = {
  record_id: string
  agent: string
  model: string | null
  startedAt: string
  status: string
  executor: 'external' | 'harness'
  failureKind: string | null
  delivery: string | null
  quality: string | null
  fidelity: string | null
  pts: number | null
  vendorTokens: number | null
  modelCalls: number | null
  peakCallTokens: number | null
  pooled: boolean
}

export type RoutingEvidenceInput = {
  status: string
  delivery: string | null
  failureKind: string | null
  executor?: 'external' | 'harness'
}

/** Row-shape form for causal replay and tests, kept equal to the SQL form by its test. */
export function isRoutingEvidence(row: RoutingEvidenceInput): boolean {
  if (row.executor === 'harness') return false
  if (!['ok', 'failed', 'stale'].includes(row.status)) return false
  if (NOT_EVIDENCE.includes(row.failureKind as (typeof NOT_EVIDENCE)[number])) return false
  return row.delivery !== null || ['failed', 'stale'].includes(row.status)
}

/** The routing evidence predicate executed by the bounded production query. */
const ROUTING_EVIDENCE_SQL = `r.status IN ('ok','failed','stale')
        AND r.executor <> 'harness'
        AND COALESCE(r.failure_kind, '') NOT IN (${NOT_EVIDENCE_SQL})
        AND (s.delivery IS NOT NULL OR r.status IN ('failed','stale'))`

export function boundedRoutingEvidenceRows(input: {
  jobName: string
  promptBytes: number
  stack?: string | null
  lens?: string | null
  currentModels: Record<string, string>
  limit: number
}): RoutingEvidenceRow[] {
  const { jobName, promptBytes, stack, lens, currentModels, limit } = input
  const rows = db()
    .query(
      `WITH current_agent(agent, model) AS (
         SELECT key, value FROM json_each(?)
       ), evidence_rows AS (
       SELECT r.record_id, r.agent, r.model, r.started_at AS startedAt, r.status,
            r.executor, r.failure_kind AS failureKind, r.vendor_tokens AS vendorTokens,
            r.model_calls AS modelCalls, r.peak_call_tokens AS peakCallTokens,
            s.delivery, s.quality, s.fidelity, ${weightCase()} AS pts, 0 AS pooled
       FROM current_agent ca
       JOIN run r INDEXED BY run_routing_evidence_cover
         ON r.agent = ca.agent AND (r.model = ca.model OR r.model IS NULL)
       LEFT JOIN score s ON s.run_record_id = r.record_id
      WHERE r.job = ? AND ${ROUTING_EVIDENCE_SQL} AND r.probe = 0
        AND r.evidence_excluded IS NULL
        AND r.parent_run_record_id IS NULL
        AND ${promptBucketSql('r', promptBytes)}
        ${stack ? 'AND r.stack = ?' : ''}
        ${lens ? 'AND EXISTS (SELECT 1 FROM review_lens rl WHERE rl.run_record_id = r.record_id AND rl.lens = ?)' : ''}
       UNION ALL
       ${POOL_ROUTING_EVIDENCE_ROWS_SQL}
       ), ranked AS (
       SELECT *,
            ROW_NUMBER() OVER (
              PARTITION BY agent ORDER BY startedAt DESC, record_id DESC
            ) AS evidence_rank
         FROM evidence_rows
       )
       SELECT record_id,agent,model,startedAt,status,executor,failureKind,vendorTokens,
              modelCalls,peakCallTokens,delivery,quality,fidelity,pts,pooled
         FROM ranked WHERE evidence_rank <= ?`,
    )
    .all(
      JSON.stringify(currentModels),
      jobName,
      ...(stack ? [stack] : []),
      ...(lens ? [lens] : []),
      ...poolScopeParams(jobName, promptBytes, stack, lens),
      limit,
    ) as (Omit<RoutingEvidenceRow, 'pooled'> & { pooled: number })[]
  return rows.map((row) => ({ ...row, pooled: row.pooled === 1 }))
}
