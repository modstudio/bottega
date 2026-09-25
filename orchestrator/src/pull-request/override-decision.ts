// concern: pull-request-override-decision
/** An admission override is valid only when a named reason is explicitly operator-attributed. */
export function validateTriageOverride(
  reason: string | undefined,
  fromOperator: boolean,
): string | null {
  if (reason === undefined) return null
  if (!reason.trim()) throw new Error('--override-triage requires a non-empty reason')
  if (!fromOperator) {
    throw new Error(
      'refusing triage override without operator attribution; rerun with --override-triage "<reason>" --from-operator',
    )
  }
  return reason.trim()
}
