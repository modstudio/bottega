import { describe, expect, test } from 'bun:test'
import { lifecycleForm, recipeElementSupport, trackedRecipeStatus } from './worktree-lifecycle.ts'

describe('worktree lifecycle declarations are measured without inference', () => {
  test('each lifecycle form follows its explicit declaration', () => {
    expect(lifecycleForm({ create: { command: 'make', args: [] } })).toBe('command-templates')
    expect(lifecycleForm({ recipe: {} })).toBe('inline-recipe')
    expect(lifecycleForm({ recipePath: '.orch/worktree.jsonc' })).toBe('tracked-recipe')
    expect(lifecycleForm({})).toBe('none')
    expect(lifecycleForm(undefined)).toBe('none')
  })

  test('a missing tracked recipe stays classified and is reported missing without being read', () => {
    const probed: string[] = []
    const status = trackedRecipeStatus(
      '/projects/app',
      { recipePath: '.orch/worktree.jsonc' },
      (path) => {
        probed.push(path)
        return false
      },
    )
    expect(status).toEqual({ path: '/projects/app/.orch/worktree.jsonc', exists: false })
    expect(probed).toEqual(['/projects/app/.orch/worktree.jsonc'])
  })
})

describe('inline recipe element support', () => {
  test('separates executed legacy keys, target-only keys, and unknown keys', () => {
    expect(
      recipeElementSupport({
        baseRef: 'main',
        install: 'bun install',
        database: { kind: 'none' },
        create: [],
        verifyDown: [],
        mystery: true,
      }),
    ).toEqual({
      supported: ['baseRef', 'install', 'database'],
      unsupported: ['create', 'verifyDown'],
      unknown: ['mystery'],
      migrationGaps: ['ordered create steps', 'create', 'verifyDown'],
    })
  })

  test('recognises target shapes that reuse legacy key names', () => {
    expect(recipeElementSupport({ env: [], serve: { default: [] }, stop: 'stop-app' })).toEqual({
      supported: ['stop'],
      unsupported: ['env', 'serve'],
      unknown: [],
      migrationGaps: [
        'plural env files',
        'named serve modes',
        'named ports',
        'owned stop verb',
        'env',
        'serve',
      ],
    })
  })
})
