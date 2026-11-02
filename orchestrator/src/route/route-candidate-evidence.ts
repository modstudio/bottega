// concern: route candidate evidence
/** Reads aggregate and latency evidence for candidate orchestration. */

import { db } from '../database/db.ts'
import { NOT_EVIDENCE_SQL } from '../failure/failure.ts'
import { promptBucketSql, promptSizeBucket } from './prompt-size-bucket.ts'
import { weightCase } from './route-selection.ts'
import { POOL_CANDIDATE_ROWS_SQL, POOL_LATENCY_ROWS_SQL } from './routing-pool-evidence.ts'

export type CandidateEvidenceSummary = {
  agent: string
  runs: number
  scored: number
  failures: number
  pts: number | null
  tokens: number
  cost: number
}

function poolParams(
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

export function candidateEvidenceSummaries(
  jobName: string,
  promptBytes: number,
  stack?: string | null,
  lens?: string | null,
): CandidateEvidenceSummary[] {
  return db()
    .query(
      `SELECT agent, SUM(runs) AS runs, SUM(scored) AS scored,
              SUM(failures) AS failures, SUM(pts) AS pts,
              SUM(tokens) AS tokens, SUM(cost) AS cost
         FROM (
       SELECT r.agent AS agent,
              CASE WHEN r.status = 'ok' THEN 1 ELSE 0 END AS runs,
              CASE WHEN s.delivery IS NOT NULL
                        AND COALESCE(r.failure_kind, '') NOT IN (${NOT_EVIDENCE_SQL})
                   THEN 1 ELSE 0 END AS scored,
              CASE WHEN r.status IN ('failed','stale') AND s.delivery IS NULL
                        AND COALESCE(r.failure_kind, '') NOT IN (${NOT_EVIDENCE_SQL})
                   THEN 1 ELSE 0 END AS failures,
              CASE WHEN COALESCE(r.failure_kind, '') NOT IN (${NOT_EVIDENCE_SQL})
                   THEN ${weightCase()} ELSE 0 END AS pts,
              CASE WHEN r.status = 'ok' THEN COALESCE(r.vendor_tokens, 0) ELSE 0 END AS tokens,
              CASE WHEN r.status = 'ok' THEN COALESCE(r.vendor_cost_usd, 0) ELSE 0 END AS cost
         FROM run r INDEXED BY run_routing_evidence_cover
         LEFT JOIN score s ON s.run_record_id = r.record_id
        WHERE r.job = ? AND r.status IN ('ok','failed','stale') AND r.probe = 0
          AND r.evidence_excluded IS NULL
          AND r.executor <> 'harness'
          AND r.parent_run_record_id IS NULL
          AND ${promptBucketSql('r', promptBytes)}
          ${stack ? 'AND r.stack = ?' : ''}
          ${lens ? 'AND EXISTS (SELECT 1 FROM review_lens rl WHERE rl.run_record_id = r.record_id AND rl.lens = ?)' : ''}
       UNION ALL
       ${POOL_CANDIDATE_ROWS_SQL}
        ) evidence_rows
        GROUP BY agent`,
    )
    .all(
      jobName,
      ...(stack ? [stack] : []),
      ...(lens ? [lens] : []),
      ...poolParams(jobName, promptBytes, stack, lens),
    ) as CandidateEvidenceSummary[]
}

export function candidateLatencyRows(
  jobName: string,
  promptBytes: number,
  stack?: string | null,
  lens?: string | null,
): { agent: string; latency_ms: number }[] {
  return db()
    .query(
      `SELECT agent, latency_ms FROM run INDEXED BY run_routing_latency_cover
        WHERE job = ? AND status = 'ok' AND probe = 0 AND latency_ms IS NOT NULL
          AND ${promptBucketSql('run', promptBytes)}
          ${stack ? 'AND stack = ?' : ''}
          ${lens ? 'AND EXISTS (SELECT 1 FROM review_lens rl WHERE rl.run_record_id = run.record_id AND rl.lens = ?)' : ''}
       UNION ALL
       ${POOL_LATENCY_ROWS_SQL}`,
    )
    .all(
      jobName,
      ...(stack ? [stack] : []),
      ...(lens ? [lens] : []),
      ...poolParams(jobName, promptBytes, stack, lens),
    ) as { agent: string; latency_ms: number }[]
}
