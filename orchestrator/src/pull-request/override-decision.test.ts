import { expect, test } from 'bun:test'
import { decideTriageOverride } from './override-decision.ts'

const triage = (
  values: Partial<NonNullable<Parameters<typeof decideTriageOverride>[0]['triage']>> = {},
) => ({
  complete: false,
  unfinishedReviewNumbers: [],
  undisposedFindings: [],
  missingLenses: ['safety', 'craft'],
  hasNonLensGap: false,
  ...values,
})

test('an architect ceiling ruling records its attribution and remaining lenses', () => {
  expect(
    decideTriageOverride({
      ceilingRuling: 'remaining findings cannot cause harm',
      fromOperator: false,
      reviewBudget: { atCeiling: true, roundsUsed: 3, ceiling: 3 },
      triage: triage(),
    }),
  ).toEqual({
    kind: 'accept',
    reason: 'remaining findings cannot cause harm',
    attribution: 'architect-ceiling',
    missingLenses: ['craft', 'safety'],
  })
})

test('an architect ceiling ruling refuses below the review round ceiling', () => {
  expect(
    decideTriageOverride({
      ceilingRuling: 'stop here',
      fromOperator: false,
      reviewBudget: { atCeiling: false, roundsUsed: 2, ceiling: 3 },
      triage: triage({ missingLenses: ['craft'] }),
    }),
  ).toEqual({
    kind: 'refuse',
    reason:
      'refusing architect ceiling ruling before the review round ceiling is reached; rounds used 2/3',
  })
})

test('ordinary triage overrides keep operator attribution below the ceiling', () => {
  expect(
    decideTriageOverride({
      overrideReason: 'operator accepts the risk',
      fromOperator: true,
      triage: triage({ missingLenses: ['craft'] }),
    }),
  ).toEqual({
    kind: 'accept',
    reason: 'operator accepts the risk',
    attribution: 'operator',
    missingLenses: [],
  })
})

test('an architect ceiling ruling refuses unfinished reviews and undisposed findings', () => {
  const input = {
    ceilingRuling: 'stop here',
    fromOperator: false,
    reviewBudget: { atCeiling: false, roundsUsed: 2, ceiling: 3 },
  }
  expect(
    decideTriageOverride({ ...input, triage: triage({ unfinishedReviewNumbers: [4] }) }),
  ).toEqual({
    kind: 'refuse',
    reason: 'refusing architect ceiling ruling while reviews are unfinished; complete reviews 4',
  })
  expect(
    decideTriageOverride({
      ...input,
      triage: triage({ undisposedFindings: [{ reviewNumber: 3, ordinal: 2 }] }),
    }),
  ).toEqual({
    kind: 'refuse',
    reason: 'refusing architect ceiling ruling while findings are undisposed; dispose findings 3/2',
  })
})

test('override flag combinations are decided without process or storage', () => {
  const base = {
    fromOperator: false,
    reviewBudget: { atCeiling: false, roundsUsed: 1, ceiling: 3 },
    triage: triage(),
  }
  expect(decideTriageOverride(base)).toEqual({ kind: 'none' })
  expect(decideTriageOverride({ ...base, overrideReason: 'ordinary' })).toMatchObject({
    kind: 'refuse',
    reason: expect.stringContaining('--from-operator'),
  })
  expect(
    decideTriageOverride({
      ...base,
      overrideReason: 'ordinary',
      ceilingRuling: 'ceiling',
    }),
  ).toEqual({
    kind: 'refuse',
    reason: '--override-triage and --ceiling-ruling cannot be combined',
  })
})
