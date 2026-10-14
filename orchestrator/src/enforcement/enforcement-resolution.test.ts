import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { MECHANICAL_CHECK_CATALOGUE, toolchainForStack } from './enforcement-catalogue.ts'
import {
  mechanicallyEnforcedChecks,
  type ResolvedMechanicalCheck,
  resolveMechanicalChecks,
} from './enforcement-resolution.ts'

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
      enforced: false,
      tool: 'biome complexity/noExcessiveLinesPerFunction, blank lines not counted, tests exempt',
      points: ['commit', 'gate'],
      blocking: true,
      limit: 80,
      source: 'stack',
    })
    expect(row(rows, 'naming')?.points).toEqual(['commit', 'gate'])
    expect(row(rows, 'test-substance')).toMatchObject({
      source: 'default',
      enforced: true,
      points: ['write', 'gate'],
    })
    expect(row(rows, 'attribution-markers')).toMatchObject({
      source: 'default',
      enforced: true,
    })
    expect(row(rows, 'secrets')).toMatchObject({ source: 'default', enforced: false })
    expect(row(rows, 'file-placement')).toMatchObject({
      source: 'uncovered',
      enforced: false,
      tool: null,
      points: [],
      blocking: false,
      limit: null,
    })
    expect(row(rows, 'final-classes')).toMatchObject({
      source: 'not-applicable',
      enforced: false,
    })
    expect(rows).toHaveLength(MECHANICAL_CHECK_CATALOGUE.length)
  })

  test('resolves PHP-specific limits and whole-project checks at the gate', () => {
    const rows = resolved('php-laravel-vue')
    expect(row(rows, 'file-length')).toMatchObject({ limit: 500, source: 'stack' })
    expect(row(rows, 'unused-exports')).toMatchObject({
      tool: 'shipmonk/dead-code-detector',
      points: ['gate'],
      blocking: true,
      source: 'stack',
    })
    expect(row(rows, 'unreachable-code')).toMatchObject({
      points: ['gate'],
      source: 'stack',
      enforced: false,
    })
  })

  test('overlays one field without losing stack defaults', () => {
    expect(
      row(
        resolved('node', { mechanicalChecks: { 'function-length': { limit: 75 } } }),
        'function-length',
      ),
    ).toMatchObject({
      tool: 'biome complexity/noExcessiveLinesPerFunction, blank lines not counted, tests exempt',
      points: ['commit', 'gate'],
      limit: 75,
      source: 'own',
      enforced: true,
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
      enforced: false,
      reason: 'generated names',
    })
  })

  test('unknown stacks retain only general defaults', () => {
    const rows = resolved('rust')
    const covered = rows
      .filter((entry) => entry.source === 'default')
      .map((entry) => entry.category)
    expect(covered).toEqual(['test-substance', 'attribution-markers', 'spelling', 'secrets'])
    expect(row(rows, 'function-length')?.source).toBe('uncovered')
  })

  test('an override that names no tool stays uncovered, is not enforced, and keeps its note', () => {
    expect(
      row(
        resolved('node', {
          mechanicalChecks: { 'file-placement': { note: 'placement reviewed in the hook' } },
        }),
        'file-placement',
      ),
    ).toMatchObject({
      source: 'uncovered',
      enforced: false,
      tool: null,
      points: [],
      blocking: false,
      limit: null,
      note: 'placement reviewed in the hook',
    })
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
      tool: `${PLATFORM_SLUG} gate check spelling`,
      source: 'own',
    })
    expect(row(rows, 'attribution-markers')).toMatchObject({
      tool: `${PLATFORM_SLUG} no-attribution`,
      source: 'own',
    })
    expect(row(rows, 'comment-hygiene')).toMatchObject({
      tool: `${PLATFORM_SLUG} gate check comments`,
      source: 'own',
      note: 'settings.checks: commentTaskKeys, commentHistory',
    })
    expect(row(rows, 'test-substance')?.note).toBe(
      'project assertion policy; PHP policy rules: createMock',
    )
  })
})

describe('mechanicallyEnforcedChecks', () => {
  const resolvedRow = (overrides: Partial<ResolvedMechanicalCheck>): ResolvedMechanicalCheck => ({
    category: 'formatting',
    title: 'Formatting',
    scope: 'file',
    enforced: true,
    tool: 'biome format',
    points: ['gate'],
    blocking: true,
    limit: null,
    source: 'own',
    note: null,
    reason: null,
    ...overrides,
  })

  test('selects only enforced blocking commit or gate rows', () => {
    const rows = [
      resolvedRow({}),
      resolvedRow({ category: 'write-only', points: ['write'] }),
      resolvedRow({ category: 'report-only', blocking: false }),
      resolvedRow({ category: 'unadopted-default', enforced: false, source: 'stack' }),
      resolvedRow({
        category: 'opted-out',
        enforced: false,
        tool: null,
        points: [],
        blocking: false,
        source: 'opted-out',
      }),
    ]

    expect(mechanicallyEnforcedChecks(rows)).toEqual([
      { category: 'formatting', title: 'Formatting', tool: 'biome format' },
    ])
  })
})
