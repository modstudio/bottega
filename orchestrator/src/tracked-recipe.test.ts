import { describe, expect, test } from 'bun:test'
import type { TrackedRecipe } from './recipe-schema.ts'
import type { Step, StepResult } from './recipe-step.ts'
import {
  executeTrackedCreateSteps,
  type RecipeSnapshot,
  teardownTrackedRecipe,
} from './tracked-recipe.ts'

const command = { command: 'true', args: [] }
const step = (name: string): Step => ({ name, run: command, undo: command })
const result = (name: string, phase: StepResult['phase'], ok: boolean): StepResult => ({
  name,
  phase,
  status: ok ? 'ok' : 'failed',
  exitCode: ok ? 0 : 1,
  argv: ['true'],
  detail: ok ? '' : `${name} broke`,
  durationMs: 0,
})
const context = { treeRoot: '/tree', vars: {} }

describe('tracked recipe execution', () => {
  test('a create failure compensates itself and every earlier step despite an undo failure', () => {
    const recipe: TrackedRecipe = { create: [step('zero'), step('one'), step('two')] }
    const undone: string[] = []
    const outcome = executeTrackedCreateSteps(
      recipe,
      context,
      (item) => result(item.name, 'run', item.name !== 'two'),
      (item) => {
        undone.push(item.name)
        return result(item.name, 'undo', item.name !== 'one')
      },
    )
    expect(outcome.failure?.name).toBe('two')
    expect(undone).toEqual(['two', 'one', 'zero'])
    expect(outcome.compensation.map((item) => item.status)).toEqual(['ok', 'failed', 'ok'])
  })

  test('a failed teardown undo retains the tree and names the step', () => {
    const recipe: TrackedRecipe = { create: [step('zero'), step('one')] }
    const snapshot: RecipeSnapshot = {
      source: { path: '.orch/worktree.jsonc', commit: 'abc' },
      recipe,
    }
    let removed = false
    const outcome = teardownTrackedRecipe(
      {
        runId: 1,
        worktree: {
          path: '/tree',
          branch: 'branch',
          base: 'abc',
          repoRoot: '/main',
          source: 'recipe',
          mintedBranch: 'branch',
        },
        stored: { snapshot, key: null, seed: null },
        treeExists: true,
        remove: () => {
          removed = true
          return { removed: true, detail: '/tree' }
        },
      },
      (item) => result(item.name, 'run', true),
      (item) => result(item.name, 'undo', item.name !== 'one'),
    )
    expect(outcome).toEqual({
      removed: false,
      detail: 'recipe teardown failed at "one" (undo): one broke',
    })
    expect(removed).toBeFalse()
  })
})
