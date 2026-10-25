import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { decideTriageOverride } from './override-decision.ts'

const triage = (
  values: Partial<NonNullable<Parameters<typeof decideTriageOverride>[0]['triage']>> = {},
) => ({
  complete: false,
  unfinishedReviewNumbers: [],
  undisposedFindings: [],
  missingLenses: ['safety', 'craft'],
  architectReadRequired: false,
  hasNonLensGap: false,
  nonLensGaps: [],
  ...values,
})

const commandName = PLATFORM_SLUG

test('an architect ceiling ruling records its attribution and remaining lenses', () => {
  expect(
    decideTriageOverride({
      ceilingRuling: 'remaining findings cannot cause harm',
      fromOperator: false,
      commandName,
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

test('ordinary triage overrides keep operator attribution below the ceiling', () => {
  expect(
    decideTriageOverride({
      overrideReason: 'operator accepts the risk',
      fromOperator: true,
      commandName,
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
    commandName,
    reviewBudget: { atCeiling: false, roundsUsed: 2, ceiling: 3 },
  }
  expect(
    decideTriageOverride({ ...input, triage: triage({ unfinishedReviewNumbers: [4] }) }),
  ).toEqual({
    kind: 'refuse',
    reason: `refusing architect ceiling ruling while reviews are unfinished; cleared by: ${commandName} review complete 4`,
  })
  expect(
    decideTriageOverride({
      ...input,
      triage: triage({ undisposedFindings: [{ reviewNumber: 3, ordinal: 2 }] }),
    }),
  ).toEqual({
    kind: 'refuse',
    reason: `refusing architect ceiling ruling while findings are undisposed; cleared by: ${commandName} review triage 3 2 <disposition>`,
  })
})

test('an architect ceiling ruling requires review round budget facts', () => {
  expect(
    decideTriageOverride({
      ceilingRuling: 'stop here',
      fromOperator: false,
      commandName,
      triage: triage(),
    }),
  ).toEqual({
    kind: 'refuse',
    reason: 'refusing architect ceiling ruling without review round budget facts',
  })
})

test('override flag combinations are decided without process or storage', () => {
  const base = {
    fromOperator: false,
    commandName,
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
