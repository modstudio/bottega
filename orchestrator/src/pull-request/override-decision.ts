// concern: pull-request-override-decision
/** An admission override is valid only when a named reason is explicitly operator-attributed. */
export function validateTriageOverride(
  reason: string | undefined,
  fromOperator: boolean,
  reasonOption = '--override-triage',
): string | null {
  if (reason === undefined) return null
  if (!reason.trim()) throw new Error(`${reasonOption} requires a non-empty reason`)
  if (!fromOperator) {
    throw new Error(
      `refusing triage override without operator attribution; rerun with ${reasonOption} "<reason>" --from-operator`,
    )
  }
  return reason.trim()
}
