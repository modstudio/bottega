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
  commandName: string
  reviewBudget?: { atCeiling: boolean; roundsUsed: number; ceiling: number }
  triage?: CeilingTriageFacts
  overrideOption?: string
}

type CeilingRulingGuidanceInput = {
  reviewBudget: NonNullable<TriageOverrideInput['reviewBudget']>
  triage?: CeilingTriageFacts
  commandName: string
}

const CEILING_GUIDANCE_REASON = 'remaining findings cannot cause harm'

function decideCeilingRuling(input: TriageOverrideInput, reason: string): TriageOverrideDecision {
  if (!reason) return { kind: 'refuse', reason: '--ceiling-ruling requires a non-empty reason' }
  if (!input.triage) {
    return { kind: 'refuse', reason: 'refusing architect ceiling ruling without triage facts' }
  }
  if (!input.reviewBudget) {
    return {
      kind: 'refuse',
      reason: 'refusing architect ceiling ruling without review round budget facts',
    }
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
            'refusing architect ceiling ruling while reviews are unfinished; cleared by: ' +
            input.triage.unfinishedReviewNumbers
              .map((number) => `${input.commandName} review complete ${number}`)
              .join('; '),
        }
      case 'undisposed-findings':
        return {
          kind: 'refuse',
          reason:
            'refusing architect ceiling ruling while findings are undisposed; cleared by: ' +
            input.triage.undisposedFindings
              .map(
                ({ reviewNumber, ordinal }) =>
                  `${input.commandName} review triage ${reviewNumber} ${ordinal} <disposition>`,
              )
              .join('; '),
        }
      case 'non-lens-gap':
        return {
          kind: 'refuse',
          reason:
            'refusing architect ceiling ruling because triage has remaining non-lens gaps: ' +
            input.triage.nonLensGaps.join(', '),
        }
      case 'no-missing-lenses':
        return {
          kind: 'refuse',
          reason: 'refusing architect ceiling ruling because no missing lens coverage remains',
        }
    }
  }
  if (!input.reviewBudget.atCeiling) {
    return {
      kind: 'refuse',
      reason:
        'refusing architect ceiling ruling before the review round ceiling is reached; rounds used ' +
        `${input.reviewBudget.roundsUsed}/${input.reviewBudget.ceiling}; cleared by: run the round ` +
        `named by \`${input.commandName} review tier <branch>\`, or use \`${input.commandName} pr create ... ` +
        '--override-triage "<reason>" --from-operator`',
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

/** Describe ceiling-ruling eligibility using the same decision that guards admission. */
export function ceilingRulingGuidance(input: CeilingRulingGuidanceInput): string | null {
  if (!input.reviewBudget.atCeiling) return null
  const decision = decideTriageOverride({
    ceilingRuling: CEILING_GUIDANCE_REASON,
    fromOperator: false,
    commandName: input.commandName,
    reviewBudget: input.reviewBudget,
    triage: input.triage,
  })
  if (decision.kind === 'accept') {
    return (
      'the review round ceiling is reached; the architect rules under ' +
      '`.agents/rules/20-build-and-buy.md` “Review rounds are a funnel”. Read the fix with ' +
      `\`${input.commandName} review read\` and, when no remaining finding can cause harm, record ` +
      `the ruling with \`${input.commandName} pr create ... --ceiling-ruling "<reason>"\``
    )
  }
  if (input.triage?.complete) {
    return `the review round ceiling is reached; triage is complete, and ${input.commandName} pr create needs no ruling`
  }
  const reason =
    decision.kind === 'refuse' ? decision.reason : 'ceiling ruling eligibility was not decided'
  return `the review round ceiling is reached; a ceiling ruling is not available yet: ${reason}`
}
