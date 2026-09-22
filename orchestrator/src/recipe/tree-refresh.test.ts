import { describe, expect, test } from 'bun:test'
import type { TrackedRecipe } from './recipe-schema.ts'
import { executeTrackedRefreshSteps, type RecipeSnapshot } from './tracked-recipe.ts'
import {
  decideMainCheckoutBranch,
  decideTreeRefresh,
  refreshStepContext,
  requireRefreshSnapshot,
  snapshotlessRefreshPlaceholder,
} from './tree-refresh.ts'

describe('main checkout branch decision', () => {
  test('allows the registered trunk branch', () => {
    expect(decideMainCheckoutBranch('develop', 'develop')).toEqual({ action: 'refresh' })
  })

  test('refuses another branch and reports it', () => {
    expect(decideMainCheckoutBranch('feature', 'develop')).toEqual({
      action: 'refuse',
      branch: 'feature',
    })
  })

  test('refuses a detached HEAD', () => {
    expect(decideMainCheckoutBranch(null, 'develop')).toEqual({
      action: 'refuse',
      branch: null,
    })
  })
})

describe('tree refresh decision', () => {
  test('a clean current tree stays current', () => {
    expect(decideTreeRefresh({ clean: true, ownCommits: 0, behindCommits: 0 })).toEqual({
      action: 'current',
    })
  })

  test('a clean behind tree without own commits fast-forwards', () => {
    expect(decideTreeRefresh({ clean: true, ownCommits: 0, behindCommits: 3 })).toEqual({
      action: 'fast-forward',
    })
  })

  test('a clean behind tree with own commits refuses', () => {
    expect(decideTreeRefresh({ clean: true, ownCommits: 2, behindCommits: 3 })).toEqual({
      action: 'refuse',
      reason: 'diverged',
    })
  })

  test('a dirty tree refuses', () => {
    expect(decideTreeRefresh({ clean: false, ownCommits: 0, behindCommits: 0 })).toEqual({
      action: 'refuse',
      reason: 'dirty',
    })
  })
})

describe('tree refresh recipe context', () => {
  const recipe = {
    create: [],
    refresh: [
      {
        name: 'observe lifecycle',
        run: { command: 'observe', args: ['{key}', '{seed}', '{ports.web}'] },
      },
    ],
  } satisfies TrackedRecipe

  test('uses key, seed, label, base, and allocations from the recorded snapshot', () => {
    const snapshot: RecipeSnapshot = {
      source: { path: 'project.jsonc', commit: 'source-base' },
      recipe,
      allocations: { index: 4, ports: { web: 21404 }, databases: {}, strings: {} },
    }
    let vars!: ReturnType<typeof refreshStepContext>['vars']
    const failure = executeTrackedRefreshSteps(
      recipe,
      refreshStepContext({
        treeRoot: '/trees/orch-42',
        main: '/projects/example',
        branch: 'DEV-675-tree-refresh',
        head: 'new-head',
        owner: { snapshot, key: 'DEV-675', seed: 'small', rootRunId: 42 },
      }),
      (_step, received) => {
        vars = received.vars
        return {
          name: 'observe lifecycle',
          phase: 'run',
          status: 'ok',
          exitCode: 0,
          argv: [],
          detail: '',
          durationMs: 0,
        }
      },
    )

    expect(failure).toBeNull()
    expect(vars.key).toBe('DEV-675')
    expect(vars.seed).toBe('small')
    expect(vars.base).toBe('source-base')
    expect(vars.label).toBe('orch.run=42')
    expect(vars.index).toBe('4')
    expect(vars['ports.web']).toBe('21404')
  })

  test('refuses a snapshot-less refresh naming the step and lifecycle placeholder', () => {
    expect(() => requireRefreshSnapshot(recipe, false, '/trees/orch-42')).toThrow(
      'refresh step "observe lifecycle" references lifecycle placeholder {key}, but worktree /trees/orch-42 has no recorded recipe snapshot',
    )

    expect(snapshotlessRefreshPlaceholder(recipe)).toEqual({
      step: 'observe lifecycle',
      placeholder: 'key',
    })
  })
})
