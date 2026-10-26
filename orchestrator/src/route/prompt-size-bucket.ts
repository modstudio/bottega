/**
 * The provisional boundary between small and large prompt evidence.
 *
 * Chosen from the observed file-question populations: small prompts topped out
 * at about 2.3 KiB and the problematic large inputs began around 25 KiB, with
 * no runs in between. 16 KiB sits in that wide empty gap, so the partition does
 * not depend on a finely tuned number. Revisit it when a run lands in the gap.
 */
export const PROMPT_SIZE_BOUNDARY = 16 * 1024

export type PromptSizeBucket = 'small' | 'large'

export function promptSizeBucket(promptBytes: number): PromptSizeBucket {
  return promptBytes < PROMPT_SIZE_BOUNDARY ? 'small' : 'large'
}

/**
 * Whether a surface-routed pick's measured size lands in the same evidence
 * bucket as the run's own measurement. Both sides are estimates of prompt
 * size, not the recorded `run.prompt_bytes`: the pre-pick ranks on the raw
 * caller text, while the run measures its composed pack before the bound
 * line, review-calibration suffix, and the other text appended after the
 * pick. A run within that appended band of `PROMPT_SIZE_BOUNDARY` can still
 * land on the other side. A routed selection only describes the cell it
 * ranked in, so the run honors it solely when both estimates fall on the
 * same side of the boundary.
 */
export function samePromptSizeBucket(routedBytes: number, runPromptBytes: number): boolean {
  return promptSizeBucket(routedBytes) === promptSizeBucket(runPromptBytes)
}

export function promptSizeBucketLabel(bucket: PromptSizeBucket): string {
  return bucket === 'small' ? '<16 KiB' : '>=16 KiB'
}

/** The SQL predicate selecting runs in the same prompt-size bucket as `promptBytes`. */
export function promptBucketSql(alias: string, promptBytes: number): string {
  return promptSizeBucket(promptBytes) === 'small'
    ? `${alias}.prompt_bytes < ${PROMPT_SIZE_BOUNDARY}`
    : `${alias}.prompt_bytes >= ${PROMPT_SIZE_BOUNDARY}`
}
