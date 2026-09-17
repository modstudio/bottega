import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  DEFAULT_PROJECT_CONFIG_PATH,
  lifecycleForm,
  lifecycleReportLines,
  recipeElementSupport,
  resolveWorktreeLifecycle,
  trackedRecipeStatus,
} from './worktree-lifecycle.ts'

describe('worktree lifecycle declarations are measured without inference', () => {
  test('each lifecycle form follows its explicit declaration', () => {
    expect(lifecycleForm({ create: { command: 'make', args: [] } })).toBe('command-templates')
    expect(lifecycleForm({ remove: 'remove', sweep: 'sweep' })).toBe('none')
    expect(lifecycleForm({ recipe: {} })).toBe('inline-recipe')
    expect(lifecycleForm({ recipePath: '.orch/worktree.jsonc' })).toBe('tracked-recipe')
    expect(lifecycleForm({})).toBe('none')
    expect(lifecycleForm(undefined)).toBe('none')
  })

  test('the default project config path is composed from the platform slug', () => {
    expect(DEFAULT_PROJECT_CONFIG_PATH).toBe(`${PLATFORM_SLUG}.jsonc`)
  })

  test('resolution applies the declared precedence before the default', () => {
    expect(
      resolveWorktreeLifecycle(
        { create: { command: 'make', args: [] }, recipe: {}, recipePath: 'custom.jsonc' },
        true,
      ),
    ).toEqual({ form: 'command-templates' })
    expect(resolveWorktreeLifecycle({ recipe: {}, recipePath: 'custom.jsonc' }, true)).toEqual({
      form: 'inline-recipe',
    })
    expect(resolveWorktreeLifecycle({ recipePath: 'custom.jsonc' }, true)).toEqual({
      form: 'tracked-recipe',
      recipePath: 'custom.jsonc',
      source: 'declared',
    })
    expect(resolveWorktreeLifecycle(undefined, true)).toEqual({
      form: 'tracked-recipe',
      recipePath: DEFAULT_PROJECT_CONFIG_PATH,
      source: 'default',
    })
    expect(resolveWorktreeLifecycle(undefined, false)).toEqual({ form: 'none' })
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

  test('doctor lifecycle lines report tracked recipe validity or the first refusal', () => {
    const projects = [
      { name: 'app', path: '/projects/app', worktree: { recipePath: '.orch/worktree.jsonc' } },
    ]
    expect(
      lifecycleReportLines(
        projects,
        () => true,
        () => ({ ok: true, recipe: { create: [] } }),
      )[0],
    ).toContain('valid')
    expect(
      lifecycleReportLines(
        projects,
        () => true,
        () => ({
          ok: false,
          errors: ['first refusal', 'second refusal'],
        }),
      )[0],
    ).toContain('invalid (2 error(s)); first: first refusal')
  })

  test('doctor names a default tracked path and distinguishes it from a declaration', () => {
    const valid = () => ({ ok: true as const, recipe: { create: [] } })
    const declared = lifecycleReportLines(
      [{ name: 'declared', path: '/projects/declared', worktree: { recipePath: 'custom.jsonc' } }],
      () => true,
      valid,
    )[0]!
    const inferred = lifecycleReportLines(
      [{ name: 'default', path: '/projects/default' }],
      () => true,
      valid,
    )[0]!
    expect(declared).toContain('(custom.jsonc, declared)')
    expect(inferred).toContain(`(${DEFAULT_PROJECT_CONFIG_PATH}, default)`)
  })

  test('doctor reports declared sharing only when present', () => {
    const projects = [
      { name: 'app', path: '/projects/app', worktree: { recipePath: '.orch/worktree.jsonc' } },
    ]
    const withoutShared = lifecycleReportLines(
      projects,
      () => true,
      () => ({ ok: true, recipe: { create: [] } }),
    )[0]!
    const withShared = lifecycleReportLines(
      projects,
      () => true,
      () => ({
        ok: true,
        recipe: {
          create: [],
          shared: [
            { name: 'vendor', kind: 'path' as const, from: 'vendor', at: 'vendor' },
            { name: 'redis', kind: 'service' as const, from: 'redis', at: 'redis' },
          ],
        },
      }),
    )[0]!
    expect(withoutShared).not.toContain('shared:')
    expect(withShared).toContain('shared: 2 declared')
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
