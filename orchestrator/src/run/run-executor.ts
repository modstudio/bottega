// concern: run-executor
/** Persisted execution kinds and their evidence policy. */

export const HARNESS_AGENT = 'harness'
export const HARNESS_EXECUTOR = 'harness'
export const EXTERNAL_EXECUTOR = 'external'
export const HARNESS_EVIDENCE_EXCLUSION = 'harness execution'

export type RunExecutor = typeof HARNESS_EXECUTOR | typeof EXTERNAL_EXECUTOR
