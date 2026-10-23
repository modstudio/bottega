import { expect, test } from 'bun:test'
import { decideTriageOverride, validateTriageOverride } from './override-decision.ts'

test('triage override requires operator attribution', () => {
  expect(() => validateTriageOverride('urgent', false)).toThrow('--from-operator')
  expect(() => validateTriageOverride('urgent', false, '--reason')).toThrow(
    '--reason "<reason>" --from-operator',
  )
  expect(validateTriageOverride(' urgent ', true)).toBe('urgent')
  expect(validateTriageOverride(undefined, false)).toBeNull()
})

test('an architect ceiling ruling records its attribution and remaining lenses', () => {
  expect(
    decideTriageOverride({
      ceilingRuling: 'remaining findings cannot cause harm',
      fromOperator: false,
      roundsUsed: 3,
      ceiling: 3,
      missingLenses: ['safety', 'craft'],
    }),
  ).toEqual({
    kind: 'accept',
    reason: 'remaining findings cannot cause harm',
    attribution: 'architect-ceiling',
    missingLenses: ['safety', 'craft'],
  })
})

test('an architect ceiling ruling refuses below the review round ceiling', () => {
  expect(
    decideTriageOverride({
      ceilingRuling: 'stop here',
      fromOperator: false,
      roundsUsed: 2,
      ceiling: 3,
      missingLenses: ['craft'],
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
      roundsUsed: 1,
      ceiling: 3,
      missingLenses: ['craft'],
    }),
  ).toEqual({
    kind: 'accept',
    reason: 'operator accepts the risk',
    attribution: 'operator',
    missingLenses: [],
  })
})
