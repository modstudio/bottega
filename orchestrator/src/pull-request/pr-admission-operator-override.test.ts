import { expect, test } from 'bun:test'
import { operatorOverrideForPullRequestCreate } from './pr-admission.ts'

test('only an accepted current operator override reaches pull request creation policy floors', () => {
  expect(
    operatorOverrideForPullRequestCreate({
      overrideReason: 'operator ruling',
      fromOperator: true,
    }),
  ).toEqual({ reason: 'operator ruling' })
  expect(
    operatorOverrideForPullRequestCreate({
      ceilingRuling: 'architect ceiling ruling',
      fromOperator: true,
    }),
  ).toBeUndefined()
  expect(() => operatorOverrideForPullRequestCreate({ overrideReason: 'operator ruling' })).toThrow(
    'refusing triage override without operator attribution',
  )
})
