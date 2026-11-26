import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { acceptedOperatorOverride } from './override-decision.ts'

test('only an accepted current operator override reaches pull request creation policy floors', () => {
  expect(
    acceptedOperatorOverride({
      overrideReason: 'operator ruling',
      fromOperator: true,
      commandName: PLATFORM_SLUG,
    }),
  ).toEqual({ reason: 'operator ruling' })
  expect(
    acceptedOperatorOverride({
      ceilingRuling: 'architect ceiling ruling',
      fromOperator: true,
      commandName: PLATFORM_SLUG,
    }),
  ).toBeUndefined()
  expect(() =>
    acceptedOperatorOverride({
      overrideReason: 'operator ruling',
      fromOperator: false,
      commandName: PLATFORM_SLUG,
    }),
  ).toThrow('refusing triage override without operator attribution')
})
