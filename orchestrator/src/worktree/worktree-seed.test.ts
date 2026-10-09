import { expect, test } from 'bun:test'
import { seedPreflight } from './worktree-seed.ts'

const recipeSeeds = { choices: ['small', 'full'], default: 'small' }

test('tree open chooses an explicit seed, recorded launch seed, default, or a useful refusal', () => {
  expect(
    seedPreflight({
      requested: 'full',
      inherited: 'recorded',
      registerChoices: undefined,
      recipeSeeds,
    }),
  ).toEqual({ seed: 'full', refusal: null })
  expect(
    seedPreflight({
      requested: undefined,
      inherited: 'recorded',
      registerChoices: undefined,
      recipeSeeds,
    }),
  ).toEqual({ seed: 'recorded', refusal: null })
  expect(
    seedPreflight({
      requested: undefined,
      registerChoices: undefined,
      recipeSeeds,
    }),
  ).toEqual({ seed: 'small', refusal: null })

  const refused = seedPreflight({
    requested: undefined,
    registerChoices: undefined,
    recipeSeeds: { choices: ['small', 'full'] },
  })
  expect(refused.seed).toBeUndefined()
  expect(refused.refusal).toContain('--seed small')
  expect(refused.refusal).toContain('--seed full')
})

test('tree create chooses an explicit seed, default, refusal, or no seed for an undeclared project', () => {
  expect(seedPreflight({ requested: 'full', registerChoices: undefined, recipeSeeds })).toEqual({
    seed: 'full',
    refusal: null,
  })
  expect(seedPreflight({ requested: undefined, registerChoices: undefined, recipeSeeds })).toEqual({
    seed: 'small',
    refusal: null,
  })

  const refused = seedPreflight({
    requested: undefined,
    registerChoices: undefined,
    recipeSeeds: { choices: ['small', 'full'] },
  })
  expect(refused.seed).toBeUndefined()
  expect(refused.refusal).toContain('--seed small')
  expect(refused.refusal).toContain('--seed full')
  expect(
    seedPreflight({
      requested: undefined,
      registerChoices: undefined,
      recipeSeeds: undefined,
    }),
  ).toEqual({ seed: undefined, refusal: null })
})
