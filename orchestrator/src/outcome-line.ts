// concern: command output
/** Formats the terminal plain-text line for commands whose recorded work can fail. */

export type OutcomeLineInput =
  | { kind: 'gate'; id: number; exitCode: number; commit: string }
  | {
      kind: 'gate'
      id: number
      exitCode: number
      commit: null
      commitUnknown: 'dirty-before' | 'changed-during'
    }
  | { kind: 'exec' | 'probe'; id: number; exitCode: number; signal: string | null }

export function formatOutcomeLine(input: OutcomeLineInput): string {
  const prefix = `${input.kind} ${input.id}`
  if (input.kind !== 'gate' && input.signal) return `${prefix} killed by ${input.signal}`
  const outcome = input.exitCode === 0 ? 'passed' : `failed (exit ${input.exitCode})`
  if (input.kind !== 'gate') return `${prefix} ${outcome}`
  if (!('commitUnknown' in input)) return `${prefix} ${outcome} at ${input.commit}`
  const reason =
    input.commitUnknown === 'dirty-before'
      ? 'the tree had uncommitted changes'
      : 'the tree changed while the gate ran'
  return `${prefix} ${outcome}; commit unknown: ${reason}`
}
