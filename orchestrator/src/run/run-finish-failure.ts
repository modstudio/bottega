// concern: run-finish-failure
/** Decides whether a finish-path failure may replace the run's current outcome. */
import { TERMINAL_RUN_STATUS_SET } from './run-status.ts'

export function shouldWriteFinishFailure(currentStatus: string): boolean {
  return !TERMINAL_RUN_STATUS_SET.has(currentStatus)
}
