import { describe, expect, test } from 'bun:test'
import type { Step } from './recipe-step.ts'
import {
  missingRecipeExecutables,
  recipeExecutableRefusal,
} from './recipe-executable-preflight.ts'

const step = (command: string, exec?: Step['exec']): Step => ({
  name: 'root-deps',
  run: { command, args: [] },
  ...(exec ? { exec } : {}),
})

describe('recipe executable prerequisites', () => {
  test('reports a missing host tool and formats the complete remedy', () => {
    const missing = missingRecipeExecutables([{ phase: 'create', step: step('bun') }], () => false)
    expect(missing).toEqual([{ phase: 'create', step: 'root-deps', tool: 'bun' }])
    expect(recipeExecutableRefusal('bottega', missing[0]!)).toBe(
      'project bottega worktree recipe step root-deps (create) needs bun, which is not on PATH; install bun, then retry',
    )
  })

  test('returns nothing when the host tool is present', () => {
    expect(missingRecipeExecutables([{ phase: 'create', step: step('bun') }], () => true)).toEqual(
      [],
    )
  })

  test('skips commands whose executable cannot be derived for the host', () => {
    const steps = [
      step('container-tool', { where: 'container', service: 'app' }),
      step('user-tool', { where: 'as-user', user: 'worker' }),
      step('{runtime}'),
      step('./scripts/setup'),
    ].map((entry) => ({ phase: 'create', step: entry }))
    expect(missingRecipeExecutables(steps, () => false)).toEqual([])
  })
})
