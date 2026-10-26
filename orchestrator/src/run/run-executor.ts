// concern: run-executor
/** Persisted execution kinds and their evidence policy. */

export { HARNESS_EVIDENCE_EXCLUSION } from '../failure/failure.ts'

export const HARNESS_AGENT = 'harness'
export const HARNESS_EXECUTOR = 'harness'
export const EXTERNAL_EXECUTOR = 'external'
export type RunExecutor = typeof HARNESS_EXECUTOR | typeof EXTERNAL_EXECUTOR

export function intendedExecutor(harness: boolean): RunExecutor {
  return harness ? HARNESS_EXECUTOR : EXTERNAL_EXECUTOR
}
