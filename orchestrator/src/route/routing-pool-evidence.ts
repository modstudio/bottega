// concern: routing pool evidence
/** SQL fragments that project hosted routing evidence into local routing reads. */

import { NOT_EVIDENCE_SQL } from '../failure/failure.ts'
import { PROMPT_SIZE_BOUNDARY, promptSizeBucket } from './prompt-size-bucket.ts'
import { weightCase } from './route-selection.ts'

const LOCAL_RUN_DEDUPLICATION = 'NOT EXISTS (SELECT 1 FROM run WHERE run.record_id = p.record_id)'

const POOL_SCOPE_SQL = `p.executor <> 'harness'
  AND p.evidence_excluded IS NULL
  AND COALESCE(p.failure_kind, '') NOT IN (${NOT_EVIDENCE_SQL})
  AND ${LOCAL_RUN_DEDUPLICATION}
  AND (p.prompt_bytes < ${PROMPT_SIZE_BOUNDARY}) = ?
  AND (? IS NULL OR p.stack = ?)
  AND (? IS NULL OR EXISTS (
    SELECT 1 FROM routing_pool_lens pl
     WHERE pl.run_record_id = p.record_id AND pl.lens = ?
  ))`

export function poolScopeParams(
  jobName: string,
  promptBytes: number,
  stack: string | null | undefined,
  lens: string | null | undefined,
): (string | number | null)[] {
  return [
    jobName,
    promptSizeBucket(promptBytes) === 'small' ? 1 : 0,
    stack ?? null,
    stack ?? null,
    lens ?? null,
    lens ?? null,
  ]
}

export const POOL_CANDIDATE_ROWS_SQL = `SELECT p.agent AS agent,
              CASE WHEN p.status = 'ok' THEN 1 ELSE 0 END AS runs,
              CASE WHEN p.delivery IS NOT NULL THEN 1 ELSE 0 END AS scored,
              CASE WHEN p.status IN ('failed','stale') AND p.delivery IS NULL THEN 1 ELSE 0 END AS failures,
              ${weightCase('p')} AS pts,
              CASE WHEN p.status = 'ok' THEN COALESCE(p.vendor_tokens, 0) ELSE 0 END AS tokens,
              0 AS cost
  FROM routing_pool_run p
 WHERE p.job = ? AND p.status IN ('ok','failed','stale') AND ${POOL_SCOPE_SQL}`

export const POOL_LATENCY_ROWS_SQL = `SELECT p.agent, p.latency_ms FROM routing_pool_run p
        WHERE p.job = ? AND p.status = 'ok' AND p.latency_ms IS NOT NULL
          AND ${POOL_SCOPE_SQL}`

export const POOL_ROUTING_EVIDENCE_ROWS_SQL = `SELECT p.record_id, p.agent, p.model, p.started_at AS startedAt, p.status,
            p.executor, p.failure_kind AS failureKind, p.vendor_tokens AS vendorTokens,
            p.model_calls AS modelCalls, p.peak_call_tokens AS peakCallTokens,
            p.delivery, p.quality, p.fidelity, ${weightCase('p')} AS pts, 1 AS pooled
       FROM current_agent ca
       JOIN routing_pool_run p
         ON p.agent = ca.agent AND (p.model = ca.model OR p.model IS NULL)
      WHERE p.job = ? AND p.status IN ('ok','failed','stale')
        AND (p.delivery IS NOT NULL OR p.status IN ('failed','stale'))
        AND ${POOL_SCOPE_SQL}`

export const POOL_PROMPT_BUCKET_ROWS_SQL = `SELECT DISTINCT
       CASE WHEN p.prompt_bytes < ? THEN 'small' ELSE 'large' END AS bucket
  FROM routing_pool_run p
 WHERE p.job = ? AND p.status IN ('ok','failed','stale')
   AND p.executor <> 'harness' AND p.evidence_excluded IS NULL
   AND COALESCE(p.failure_kind, '') NOT IN (${NOT_EVIDENCE_SQL})
   AND ${LOCAL_RUN_DEDUPLICATION} AND p.agent != '(pending)'`

export const POOL_SUCCESSFUL_RUN_SAMPLES_SQL = `SELECT p.job, p.agent, p.latency_ms, p.prompt_bytes
  FROM routing_pool_run p
 WHERE p.status = 'ok' AND p.latency_ms IS NOT NULL
   AND p.executor <> 'harness' AND p.evidence_excluded IS NULL
   AND COALESCE(p.failure_kind, '') NOT IN (${NOT_EVIDENCE_SQL})
   AND ${LOCAL_RUN_DEDUPLICATION}`
