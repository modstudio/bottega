import { describe, expect, test } from 'bun:test'
import {
  compensationPlan,
  destroyPlan,
  lifecycleFailure,
  trackedExecutionRefusal,
} from './recipe-lifecycle.ts'
import type { TrackedRecipe } from './recipe-schema.ts'
import type { Step, StepResult } from './recipe-step.ts'

const command = { command: 'true', args: [] }
const step = (name: string, undo = true): Step => ({
  name,
  run: command,
  ...(undo ? { undo: command } : {}),
})
const recipe = (extra: Partial<TrackedRecipe> = {}): TrackedRecipe => ({ create: [], ...extra })

describe('tracked recipe lifecycle planning', () => {
  test.each([
    ['allocate', 5, { ports: ['web'] }],
    ['env', 7, []],
    ['shared', 8, []],
    ['serve', 9, {}],
  ] as const)('refuses %s until slice %i', (field, slice, value) => {
    expect(trackedExecutionRefusal(recipe({ [field]: value }))).toBe(
      `tracked recipe declares ${field}, which is not executable yet (Phase 3 slice ${slice})`,
    )
  })

  test('accepts only the lifecycle arrays executed by this slice', () => {
    expect(trackedExecutionRefusal(recipe({ pre: [], destroy: [], verifyDown: [] }))).toBeNull()
  })

  test('compensates the failed step and earlier undoable steps in reverse', () => {
    const input = recipe({
      create: [step('zero'), step('skip', false), step('two'), step('later')],
    })
    expect(compensationPlan(input, 2).map((item) => item.name)).toEqual(['two', 'zero'])
  })

  test('uses explicit destroy steps, otherwise reverse create undos', () => {
    expect(
      destroyPlan(recipe({ create: [step('zero'), step('one')] })).map((x) => [
        x.step.name,
        x.phase,
      ]),
    ).toEqual([
      ['one', 'undo'],
      ['zero', 'undo'],
    ])
    expect(
      destroyPlan(recipe({ create: [step('create')], destroy: [step('destroy', false)] })),
    ).toEqual([{ step: step('destroy', false), phase: 'run' }])
  })

  test('selects the first non-ok result', () => {
    const result = (name: string, status: StepResult['status']): StepResult => ({
      name,
      status,
      phase: 'run',
      exitCode: status === 'ok' ? 0 : 1,
      argv: [],
      detail: name,
      durationMs: 0,
    })
    expect(
      lifecycleFailure([result('ok', 'ok'), result('first', 'failed'), result('second', 'refused')])
        ?.name,
    ).toBe('first')
  })
})
