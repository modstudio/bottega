import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { MECHANICAL_CHECK_CATALOGUE, toolchainForStack } from './enforcement-catalogue.ts'
import { resolveMechanicalChecks } from './enforcement-resolution.ts'

const resolved = (
  stack: string | null,
  settings: Parameters<typeof resolveMechanicalChecks>[0]['settings'] = {},
) => resolveMechanicalChecks({ stack, settings })

const row = (rows: ReturnType<typeof resolved>, category: string) =>
  rows.find((entry) => entry.category === category)

describe('toolchainForStack', () => {
  test('maps only declared node and PHP stack labels', () => {
    expect(toolchainForStack('node')).toBe('typescript')
    expect(toolchainForStack('node-drizzle')).toBe('typescript')
    expect(toolchainForStack('php-laravel-vue')).toBe('php')
    expect(toolchainForStack('typescript')).toBe('unknown')
    expect(toolchainForStack(null)).toBe('unknown')
  })
})

describe('resolveMechanicalChecks', () => {
  test('resolves TypeScript stack, general, uncovered, and inapplicable categories', () => {
    const rows = resolved('node')
    expect(row(rows, 'function-length')).toMatchObject({
      tool: 'biome complexity/noExcessiveLinesPerFunction',
      points: ['write', 'commit'],
      blocking: true,
      limit: 50,
      source: 'stack',
    })
    expect(row(rows, 'test-substance')?.source).toBe('default')
    expect(row(rows, 'file-placement')?.source).toBe('uncovered')
    expect(row(rows, 'final-classes')?.source).toBe('not-applicable')
    expect(rows).toHaveLength(MECHANICAL_CHECK_CATALOGUE.length)
  })

  test('resolves PHP-specific limits and scheduled nonblocking checks', () => {
    const rows = resolved('php-laravel-vue')
    expect(row(rows, 'file-length')).toMatchObject({ limit: 300, source: 'stack' })
    expect(row(rows, 'unused-exports')).toMatchObject({
      tool: 'shipmonk/dead-code-detector',
      points: ['schedule'],
      blocking: false,
      source: 'stack',
    })
  })

  test('overlays one field without losing stack defaults', () => {
    expect(
      row(
        resolved('node', { mechanicalChecks: { 'function-length': { limit: 75 } } }),
        'function-length',
      ),
    ).toMatchObject({
      tool: 'biome complexity/noExcessiveLinesPerFunction',
      points: ['write', 'commit'],
      limit: 75,
      source: 'own',
    })
  })

  test('reports opt-outs without a tool', () => {
    expect(
      row(
        resolved('node', {
          mechanicalChecks: { naming: { optOut: { reason: 'generated names' } } },
        }),
        'naming',
      ),
    ).toMatchObject({
      tool: null,
      source: 'opted-out',
      reason: 'generated names',
    })
  })

  test('unknown stacks retain only general defaults', () => {
    const rows = resolved('rust')
    const covered = rows
      .filter((entry) => entry.source === 'default')
      .map((entry) => entry.category)
    expect(covered).toEqual(['test-substance', 'attribution-markers', 'secrets'])
    expect(row(rows, 'function-length')?.source).toBe('uncovered')
  })

  test('shows retained check switches as own rows and combines notes', () => {
    const rows = resolved('node', {
      checks: {
        spelling: true,
        attribution: true,
        commentTaskKeys: true,
        commentHistory: { phrases: ['old'] },
      },
      mechanicalChecks: { 'test-substance': { note: 'project assertion policy' } },
      testSubstance: { phpPolicyRules: ['createMock'] },
    })
    expect(row(rows, 'spelling')).toMatchObject({
      tool: 'orch check spelling',
      source: 'own',
    })
    expect(row(rows, 'attribution-markers')).toMatchObject({
      tool: `${PLATFORM_SLUG} no-attribution`,
      source: 'own',
    })
    expect(row(rows, 'comment-hygiene')).toMatchObject({
      tool: 'orch check comments',
      source: 'own',
      note: 'settings.checks: commentTaskKeys, commentHistory',
    })
    expect(row(rows, 'test-substance')?.note).toBe(
      'project assertion policy; PHP policy rules: createMock',
    )
  })
})
