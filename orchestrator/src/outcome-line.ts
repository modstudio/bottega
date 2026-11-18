// concern: command output
/** Formats the terminal plain-text line for commands whose recorded work can fail. */

export type OutcomeLineInput = {
  kind: 'gate' | 'exec' | 'probe'
  id: number
  exitCode: number
  signal: string | null
  commit?: string | null
}

export function formatOutcomeLine(input: OutcomeLineInput): string {
  const prefix = `${input.kind} ${input.id}`
  if (input.kind !== 'gate' && input.signal) return `${prefix} killed by ${input.signal}`
  const outcome = input.exitCode === 0 ? 'passed' : `failed (exit ${input.exitCode})`
  if (input.kind !== 'gate') return `${prefix} ${outcome}`
  return input.commit
    ? `${prefix} ${outcome} at ${input.commit}`
    : `${prefix} ${outcome}; commit unknown: the gate rewrote the tree`
}
