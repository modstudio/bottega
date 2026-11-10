import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  decideProjectSpaceFill,
  hostedProjectSpaceSlugs,
  projectSpaceFillRemedy,
  spaceFillNeedsRuling,
} from './project-fill-space-decision.ts'

const memberships = [
  { spaceId: 'space-a', slug: 'alpha', permission: 'write' },
  { spaceId: 'space-b', slug: 'beta', permission: 'write' },
]

describe('decideProjectSpaceFill', () => {
  test('classifies the five backfill outcomes', () => {
    expect(
      decideProjectSpaceFill({ declared: 'alpha', memberships, hostedSpaceIds: ['space-a'] }),
    ).toEqual({ kind: 'ok' })
    expect(decideProjectSpaceFill({ memberships, hostedSpaceIds: ['space-a'] })).toEqual({
      kind: 'fill',
      space: 'alpha',
    })
    expect(
      decideProjectSpaceFill({ memberships, hostedSpaceIds: ['space-b', 'space-a', 'space-a'] }),
    ).toEqual({ kind: 'several-spaces', spaces: ['alpha', 'beta'] })
    expect(decideProjectSpaceFill({ memberships, hostedSpaceIds: [] })).toEqual({
      kind: 'no-hosted-row',
    })
    expect(
      decideProjectSpaceFill({ declared: 'alpha', memberships, hostedSpaceIds: ['space-b'] }),
    ).toEqual({ kind: 'mismatch', declared: 'alpha', spaces: ['beta'] })
  })

  test('a declaration outside the memberships is a mismatch', () => {
    expect(
      decideProjectSpaceFill({ declared: 'elsewhere', memberships, hostedSpaceIds: [] }),
    ).toEqual({ kind: 'mismatch', declared: 'elsewhere', spaces: [] })
  })
})

test('hosted space slugs are de-duplicated and ordered once', () => {
  expect(hostedProjectSpaceSlugs(memberships, ['space-b', 'space-a', 'space-b'])).toEqual([
    'alpha',
    'beta',
  ])
})

test('identifies decisions that need a ruling', () => {
  expect(spaceFillNeedsRuling({ kind: 'ok' })).toBeFalse()
  expect(spaceFillNeedsRuling({ kind: 'fill', space: 'alpha' })).toBeFalse()
  expect(spaceFillNeedsRuling({ kind: 'several-spaces', spaces: ['alpha', 'beta'] })).toBeTrue()
  expect(spaceFillNeedsRuling({ kind: 'no-hosted-row' })).toBeTrue()
  expect(spaceFillNeedsRuling({ kind: 'mismatch', declared: 'alpha', spaces: ['beta'] })).toBeTrue()
})

test('uses project push when a declared project has no hosted row', () => {
  expect(projectSpaceFillRemedy('fixture', 'alpha', { kind: 'no-hosted-row' })).toBe(
    `${PLATFORM_SLUG} project push`,
  )
  expect(projectSpaceFillRemedy('fixture', null, { kind: 'no-hosted-row' })).toBe(
    `${PLATFORM_SLUG} project set fixture --space <slug>`,
  )
})
