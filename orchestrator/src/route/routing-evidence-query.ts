// concern: routing-evidence-query
/** Reads only the current-model evidence window consumed by routing. */
import { db } from '../database/db.ts'
import { NOT_EVIDENCE } from '../failure/failure.ts'
import { promptBucketSql } from './prompt-size-bucket.ts'
import { weightCase } from './route-selection.ts'

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
}

const notEvidenceSql = () => NOT_EVIDENCE.map((kind) => `'${kind}'`).join(', ')

export function boundedRoutingEvidenceRows(input: {
  jobName: string
  promptBytes: number
  stack?: string | null
  lens?: string | null
  currentModels: Record<string, string>
  limit: number
}): RoutingEvidenceRow[] {
  const { jobName, promptBytes, stack, lens, currentModels, limit } = input
  return db()
    .query(
      `WITH current_agent(agent, model) AS (
         SELECT key, value FROM json_each(?)
       ), ranked AS (
       SELECT r.record_id, r.agent, r.model, r.started_at AS startedAt, r.status,
            r.executor, r.failure_kind AS failureKind, r.vendor_tokens AS vendorTokens,
            r.model_calls AS modelCalls, r.peak_call_tokens AS peakCallTokens,
            s.delivery, s.quality, s.fidelity, ${weightCase()} AS pts,
            ROW_NUMBER() OVER (
              PARTITION BY r.agent ORDER BY r.started_at DESC, r.record_id DESC
            ) AS evidence_rank
       FROM current_agent ca
       JOIN run r INDEXED BY run_routing_evidence_cover
         ON r.agent = ca.agent AND (r.model = ca.model OR r.model IS NULL)
       LEFT JOIN score s ON s.run_record_id = r.record_id
      WHERE r.job = ? AND r.status IN ('ok','failed','stale') AND r.probe = 0
        AND r.evidence_excluded IS NULL AND r.executor <> 'harness'
        AND r.parent_run_record_id IS NULL
        AND COALESCE(r.failure_kind, '') NOT IN (${notEvidenceSql()})
        AND (s.delivery IS NOT NULL OR r.status IN ('failed','stale'))
        AND ${promptBucketSql('r', promptBytes)}
        ${stack ? 'AND r.stack = ?' : ''}
        ${lens ? 'AND EXISTS (SELECT 1 FROM review_lens rl WHERE rl.run_record_id = r.record_id AND rl.lens = ?)' : ''}
       )
       SELECT record_id,agent,model,startedAt,status,executor,failureKind,vendorTokens,
              modelCalls,peakCallTokens,delivery,quality,fidelity,pts
         FROM ranked WHERE evidence_rank <= ?`,
    )
    .all(
      JSON.stringify(currentModels),
      jobName,
      ...(stack ? [stack] : []),
      ...(lens ? [lens] : []),
      limit,
    ) as RoutingEvidenceRow[]
}
