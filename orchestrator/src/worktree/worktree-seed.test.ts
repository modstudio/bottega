import { expect, test } from 'bun:test'
import { projectSeedValidationRequest, seedPreflight } from './worktree-seed.ts'

const recipeSeeds = { choices: ['small', 'full'], default: 'small' }

test('choice source prefers tracked recipe choices to register choices', () => {
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

test('default selects the tracked recipe default', () => {
  expect(
    seedPreflight({
      requested: undefined,
      registerChoices: ['register'],
      recipeSeeds,
    }),
  ).toEqual({ seed: 'small', refusal: null })
})

test('read-only skip does not inherit or record a recipe default seed', () => {
  expect(
    seedPreflight({
      requested: undefined,
      registerChoices: ['register'],
      recipeSeeds,
      writesRepo: false,
    }),
  ).toEqual({ seed: undefined, refusal: null })
})

test('resolver probe requires a registered create command', () => {
  const trackedRecipeProject = {
    path: '/projects/alephbeis',
    settings: { worktree: { recipePath: 'worktree.jsonc' } },
  } as Parameters<typeof projectSeedValidationRequest>[0]
  expect(projectSeedValidationRequest(trackedRecipeProject, '--full --budget-mb=700')).toBeNull()

  const commandProject = {
    path: '/projects/command-backed',
    settings: { worktree: { create: [] } },
  } as unknown as Parameters<typeof projectSeedValidationRequest>[0]
  expect(projectSeedValidationRequest(commandProject, 'full')).toEqual({
    cwd: '/projects/command-backed',
    seed: 'full',
  })
})

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
