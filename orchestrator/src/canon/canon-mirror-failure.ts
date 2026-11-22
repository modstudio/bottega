// concern: canon-mirror-failure
/** Owns the terminal failure text shape and preserves an earlier cause during cleanup. */

const FAILURE_PREFIX = 'failed, '

export type MirrorFailureOutcome = { text: string; failed: boolean }

function composeMirrorFailure(original: string | null, cleanup: string): string {
  return original ? `${original}; ${cleanup}` : cleanup
}

export function mirrorFailureText(reason: string): string {
  return `${FAILURE_PREFIX}${reason}`
}

export function appendMirrorFailure(input: {
  outcome: MirrorFailureOutcome
  reason: string
  runId: string
  started: number
  setTerminal(runId: string, started: number, error: string): void
}): string {
  const original = input.outcome.failed
    ? input.outcome.text.startsWith(FAILURE_PREFIX)
      ? input.outcome.text.slice(FAILURE_PREFIX.length)
      : input.outcome.text
    : null
  const combined = composeMirrorFailure(original, input.reason)
  input.setTerminal(input.runId, input.started, combined)
  input.outcome.failed = true
  input.outcome.text = mirrorFailureText(combined)
  return input.outcome.text
}
