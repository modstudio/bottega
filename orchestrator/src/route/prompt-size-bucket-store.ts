// concern: route prompt size bucket store
import { db } from '../database/db.ts'
import { PROMPT_SIZE_BOUNDARY, type PromptSizeBucket } from './prompt-size-bucket.ts'

export function promptBucketsForJob(jobName: string): PromptSizeBucket[] {
  const rows = db()
    .query(
      `SELECT DISTINCT CASE WHEN prompt_bytes < ? THEN 'small' ELSE 'large' END AS bucket
         FROM run INDEXED BY run_routing_prompt_bucket_cover
        WHERE job = ? AND status IN ('ok','failed','stale') AND probe = 0
          AND evidence_excluded IS NULL AND executor <> 'harness'
          AND parent_run_record_id IS NULL AND agent != '(pending)'`,
    )
    .all(PROMPT_SIZE_BOUNDARY, jobName) as { bucket: PromptSizeBucket }[]
  const have = new Set(rows.map((row) => row.bucket))
  return (['small', 'large'] as const).filter((bucket) => have.has(bucket))
}
