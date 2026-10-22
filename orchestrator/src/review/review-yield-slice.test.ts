import { describe, expect, test } from 'bun:test'
import {
  isMediumPlusHit,
  mediumPlusAcceptedCount,
  mediumPlusAcceptedYield,
  NO_DECLARED_GLOB,
  UNRECORDED_SLICE,
  yieldAreaKey,
  yieldLensDeclarations,
  yieldPathAreas,
  yieldRiskKey,
  yieldSizeKey,
} from './review-yield-slice.ts'

const lenses = [
  { lens: 'correctness' },
  { lens: 'craft', minTier: 2 },
  { lens: 'test-quality', paths: ['**/*.test.ts'] },
  { lens: 'safety', paths: ['orchestrator/hooks/**', 'orchestrator/src/sandbox/**'] },
  { lens: 'test-quality', paths: ['**/*.test.tsx'] },
]

describe('yield path areas', () => {
  test('matches declared globs and ignores unscoped lenses', () => {
    expect(yieldPathAreas('["src/a.ts"]', lenses)).toEqual([NO_DECLARED_GLOB])
    expect(yieldPathAreas('["foo.test.ts"]', lenses)).toEqual(['test-quality'])
  })

  test('counts a path_set in every matching concern and keeps declaration order', () => {
    expect(
      yieldPathAreas('["foo.test.ts","orchestrator/hooks/no-attribution.py"]', lenses),
    ).toEqual(['test-quality', 'safety'])
  })

  test('collapses a concern declared twice', () => {
    expect(yieldPathAreas('["foo.test.ts","bar.test.tsx"]', lenses)).toEqual(['test-quality'])
  })

  test('an unreadable or empty path_set is the residual', () => {
    expect(yieldPathAreas(null, lenses)).toEqual([NO_DECLARED_GLOB])
    expect(yieldPathAreas('not-json', lenses)).toEqual([NO_DECLARED_GLOB])
    expect(yieldPathAreas('{"path":"a.ts"}', lenses)).toEqual([NO_DECLARED_GLOB])
    expect(yieldPathAreas('[]', lenses)).toEqual([NO_DECLARED_GLOB])
  })
})

describe('yield slice keys', () => {
  test('names size, risk and area with an unrecorded residual', () => {
    expect(yieldSizeKey('craft', 0)).toBe('craft / size 0')
    expect(yieldSizeKey('craft', null)).toBe(`craft / size ${UNRECORDED_SLICE}`)
    expect(yieldRiskKey('craft', 2)).toBe('craft / risk 2')
    expect(yieldRiskKey('craft', null)).toBe(`craft / risk ${UNRECORDED_SLICE}`)
    expect(yieldAreaKey('craft', 'test-quality')).toBe('craft / test-quality')
    expect(yieldAreaKey('craft', NO_DECLARED_GLOB)).toBe(`craft / ${NO_DECLARED_GLOB}`)
  })

  test('reads path-scoped lenses from project settings and drops a malformed blob', () => {
    expect(
      yieldLensDeclarations(
        JSON.stringify({
          review: {
            lenses: [{ lens: 'craft' }, { lens: 'safety', paths: ['hooks/**'] }],
          },
        }),
      ),
    ).toEqual([{ lens: 'craft' }, { lens: 'safety', paths: ['hooks/**'] }])
    expect(yieldLensDeclarations(null)).toEqual([])
    expect(yieldLensDeclarations('not-json')).toEqual([])
    expect(yieldLensDeclarations('{"review":{"lenses":"craft"}}')).toEqual([])
  })
})

describe('medium-plus accepted yield', () => {
  test('counts accepted or modified medium-or-higher findings only', () => {
    expect(isMediumPlusHit({ disposition: 'accepted', triaged_severity: 'medium' })).toBe(true)
    expect(isMediumPlusHit({ disposition: 'modified', triaged_severity: 'high' })).toBe(true)
    expect(isMediumPlusHit({ disposition: 'accepted', triaged_severity: 'critical' })).toBe(true)
    expect(isMediumPlusHit({ disposition: 'accepted', triaged_severity: 'low' })).toBe(false)
    expect(isMediumPlusHit({ disposition: 'rejected', triaged_severity: 'medium' })).toBe(false)
    expect(isMediumPlusHit({ disposition: null, triaged_severity: 'high' })).toBe(false)
  })

  test('yield is the share of complete runs with at least one hit', () => {
    const complete = [
      { findings: [{ disposition: 'accepted', triaged_severity: 'medium' }] },
      { findings: [{ disposition: 'accepted', triaged_severity: 'low' }] },
      { findings: [] },
      {
        findings: [
          { disposition: 'modified', triaged_severity: 'medium' },
          { disposition: 'accepted', triaged_severity: 'low' },
        ],
      },
    ]
    expect(mediumPlusAcceptedCount(complete.flatMap((row) => row.findings))).toBe(2)
    expect(mediumPlusAcceptedYield(complete)).toBe(0.5)
    expect(mediumPlusAcceptedYield([])).toBeNull()
  })
})
