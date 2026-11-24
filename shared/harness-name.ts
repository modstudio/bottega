/** The harness names carried by caller identities and session publications. */
export type HarnessName = 'claude-code' | 'codex'

export function isHarnessName(value: unknown): value is HarnessName {
  return value === 'claude-code' || value === 'codex'
}
