import { describe, expect, test } from 'bun:test'
import { decideProjectSpaceFill } from './project-fill-space-decision.ts'

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
