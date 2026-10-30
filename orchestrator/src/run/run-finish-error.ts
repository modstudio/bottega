// concern: run-finish-error
/** Owns the private markers that distinguish finish-path errors from startup failures. */

type MarkedRunFinishError = Error & {
  runFinishFailed?: true
  runId?: string
  terminalRecorded?: true
}

function errorWithCause(error: unknown): MarkedRunFinishError {
  return error instanceof Error
    ? (error as MarkedRunFinishError)
    : new Error(String(error), { cause: error })
}

export function markRunFinishFailed(error: unknown, runId: string): Error {
  return Object.assign(errorWithCause(error), { runFinishFailed: true as const, runId })
}

export function isRunFinishFailed(error: unknown): boolean {
  return error instanceof Error && (error as MarkedRunFinishError).runFinishFailed === true
}

export function markTerminalRecorded(error: unknown): Error {
  return Object.assign(errorWithCause(error), { terminalRecorded: true as const })
}

export function isTerminalRecorded(error: unknown): boolean {
  return error instanceof Error && (error as MarkedRunFinishError).terminalRecorded === true
}
