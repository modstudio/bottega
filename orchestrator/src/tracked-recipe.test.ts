import { describe, expect, test } from 'bun:test'
import type { TrackedRecipe } from './recipe-schema.ts'
import type { Step, StepResult } from './recipe-step.ts'
import {
  type AllocationAttempt,
  executeTrackedCreateSteps,
  executeTrackedPreSteps,
  type RecipeSnapshot,
  type TrackedAllocator,
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
  test('a pre failure releases only the claims inserted by this allocation attempt', () => {
    const attempt: AllocationAttempt = {
      allocations: { index: 2, ports: { web: 21001 }, strings: {} },
      insertedClaimIds: [12, 14],
    }
    const released: { attempt: AllocationAttempt; reason: string }[] = []
    const allocator: TrackedAllocator = {
      allocate: () => attempt,
      release: (releasedAttempt, reason) => released.push({ attempt: releasedAttempt, reason }),
    }
    const input: TrackedRecipe = { pre: [step('pre')], create: [] }

    expect(() =>
      executeTrackedPreSteps(input, context, attempt, allocator, (item) =>
        result(item.name, 'run', false),
      ),
    ).toThrow('worktree pre-check failed at "pre" (run): pre broke')
    expect(released).toEqual([
      {
        attempt,
        reason: 'worktree pre-check failed at "pre" (run): pre broke',
      },
    ])
    expect(released[0]!.attempt.insertedClaimIds).toEqual([12, 14])
  })

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
