// concern: pull-request-override-decision
import { type CeilingTriageFacts, ceilingWaivableGaps } from './triage-decision.ts'

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

type TriageOverrideInput = {
  overrideReason?: string
  ceilingRuling?: string
  fromOperator: boolean
  reviewBudget?: { atCeiling: boolean; roundsUsed: number; ceiling: number }
  triage?: CeilingTriageFacts
  overrideOption?: string
}

function decideCeilingRuling(input: TriageOverrideInput, reason: string): TriageOverrideDecision {
  if (!reason) return { kind: 'refuse', reason: '--ceiling-ruling requires a non-empty reason' }
  if (!input.triage) {
    return { kind: 'refuse', reason: 'refusing architect ceiling ruling without triage facts' }
  }
  const waivable = ceilingWaivableGaps(input.triage)
  if (!waivable.waivable) {
    switch (waivable.blocker) {
      case 'complete':
        return {
          kind: 'refuse',
          reason: 'refusing architect ceiling ruling because triage is complete',
        }
      case 'unfinished-reviews':
        return {
          kind: 'refuse',
          reason:
            'refusing architect ceiling ruling while reviews are unfinished; complete reviews ' +
            input.triage.unfinishedReviewNumbers.join(', '),
        }
      case 'undisposed-findings':
        return {
          kind: 'refuse',
          reason:
            'refusing architect ceiling ruling while findings are undisposed; dispose findings ' +
            input.triage.undisposedFindings
              .map(({ reviewNumber, ordinal }) => `${reviewNumber}/${ordinal}`)
              .join(', '),
        }
      case 'non-lens-gap':
        return {
          kind: 'refuse',
          reason:
            'refusing architect ceiling ruling because triage has a non-lens admission gap; ' +
            'ceiling rulings waive only missing lens coverage',
        }
      case 'no-missing-lenses':
        return {
          kind: 'refuse',
          reason: 'refusing architect ceiling ruling because no missing lens coverage remains',
        }
    }
  }
  if (!input.reviewBudget?.atCeiling) {
    const usage = input.reviewBudget
      ? `; rounds used ${input.reviewBudget.roundsUsed}/${input.reviewBudget.ceiling}`
      : ''
    return {
      kind: 'refuse',
      reason: `refusing architect ceiling ruling before the review round ceiling is reached${usage}`,
    }
  }
  return {
    kind: 'accept',
    reason,
    attribution: 'architect-ceiling',
    missingLenses: waivable.missingLenses,
  }
}

/** Decide admission overrides from review-budget facts without reaching process or storage. */
export function decideTriageOverride(input: TriageOverrideInput): TriageOverrideDecision {
  if (input.overrideReason !== undefined && input.ceilingRuling !== undefined) {
    return { kind: 'refuse', reason: '--override-triage and --ceiling-ruling cannot be combined' }
  }
  if (input.ceilingRuling !== undefined) {
    return decideCeilingRuling(input, input.ceilingRuling.trim())
  }
  if (input.overrideReason === undefined) return { kind: 'none' }
  const overrideOption = input.overrideOption ?? '--override-triage'
  const reason = input.overrideReason.trim()
  if (!reason) return { kind: 'refuse', reason: `${overrideOption} requires a non-empty reason` }
  if (!input.fromOperator) {
    return {
      kind: 'refuse',
      reason:
        `refusing triage override without operator attribution; rerun with ${overrideOption} ` +
        '"<reason>" --from-operator',
    }
  }
  return { kind: 'accept', reason, attribution: 'operator', missingLenses: [] }
}
