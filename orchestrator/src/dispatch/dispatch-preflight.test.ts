import { expect, test } from 'bun:test'
import { seedPreflight } from './dispatch-preflight.ts'

test('recipe seed guidance without a default refuses an omitted seed', () => {
  const decision = seedPreflight({
    requested: undefined,
    registerChoices: ['register'],
    recipeSeeds: { choices: ['small', 'full'] },
  })
  expect(decision.seed).toBeUndefined()
  expect(decision.refusal).toContain('has no default')
  expect(decision.refusal).toContain('--seed small')
  expect(decision.refusal).not.toContain('--seed register')
})

test('recipe seed guidance fills an omitted seed from its default', () => {
  expect(
    seedPreflight({
      requested: undefined,
      registerChoices: ['register'],
      recipeSeeds: { choices: ['small', 'full'], default: 'small' },
    }),
  ).toEqual({ seed: 'small', refusal: null })
})
