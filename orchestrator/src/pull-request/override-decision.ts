// concern: pull-request-override-decision
export type TriageOverrideAttribution = 'operator' | 'architect-ceiling'

export type TriageOverrideDecision =
  | { kind: 'none' }
  | {
      kind: 'accept'
      reason: string
      attribution: TriageOverrideAttribution
      missingLenses: string[]
    }
  | { kind: 'refuse'; reason: string }

/** Decide admission overrides from review-budget facts without reaching process or storage. */
export function decideTriageOverride(input: {
  overrideReason?: string
  ceilingRuling?: string
  fromOperator: boolean
  roundsUsed: number
  ceiling: number
  missingLenses: readonly string[]
}): TriageOverrideDecision {
  if (input.overrideReason !== undefined && input.ceilingRuling !== undefined) {
    return { kind: 'refuse', reason: '--override-triage and --ceiling-ruling cannot be combined' }
  }
  if (input.ceilingRuling !== undefined) {
    const reason = input.ceilingRuling.trim()
    if (!reason) return { kind: 'refuse', reason: '--ceiling-ruling requires a non-empty reason' }
    if (input.roundsUsed < input.ceiling) {
      return {
        kind: 'refuse',
        reason:
          `refusing architect ceiling ruling before the review round ceiling is reached; ` +
          `rounds used ${input.roundsUsed}/${input.ceiling}`,
      }
    }
    return {
      kind: 'accept',
      reason,
      attribution: 'architect-ceiling',
      missingLenses: [...input.missingLenses],
    }
  }
  if (input.overrideReason === undefined) return { kind: 'none' }
  const reason = input.overrideReason.trim()
  if (!reason) return { kind: 'refuse', reason: '--override-triage requires a non-empty reason' }
  if (!input.fromOperator) {
    return {
      kind: 'refuse',
      reason:
        'refusing triage override without operator attribution; rerun with --override-triage "<reason>" --from-operator',
    }
  }
  return { kind: 'accept', reason, attribution: 'operator', missingLenses: [] }
}

/** An ordinary admission override is valid only when explicitly operator-attributed. */
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
