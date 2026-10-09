import { describe, expect, test } from 'bun:test'
import { recordSpaceMembership } from './record-space-membership.ts'
import { recordSpaceRequestDecision } from './record-space-request.ts'

const memberships = [
  { spaceId: 'space-a', slug: 'active' },
  { spaceId: 'space-b', slug: 'declared' },
]

describe('record space request', () => {
  test('keeps the active space without a request', () => {
    expect(recordSpaceRequestDecision(null, 'space-a', memberships)).toEqual({
      allowed: true,
      spaceId: 'space-a',
    })
  })

  test('binds a requested member space by slug or id', () => {
    expect(recordSpaceRequestDecision('declared', 'space-a', memberships)).toEqual({
      allowed: true,
      spaceId: 'space-b',
    })
    expect(recordSpaceRequestDecision('space-b', 'space-a', memberships)).toEqual({
      allowed: true,
      spaceId: 'space-b',
    })
  })

  test('refuses a non-member before a tenant can be bound', () => {
    expect(recordSpaceRequestDecision('outside', 'space-a', memberships)).toEqual({
      allowed: false,
      requestedSpace: 'outside',
    })
  })

  test.each([
    [
      { spaceId: 'space-id', slug: 'ordinary' },
      { spaceId: 'other-id', slug: 'space-id' },
    ],
    [
      { spaceId: 'other-id', slug: 'space-id' },
      { spaceId: 'space-id', slug: 'ordinary' },
    ],
  ])('an exact id wins over a shadowing slug regardless of membership order', (...ordered) => {
    expect(recordSpaceMembership('space-id', ordered)).toEqual({
      spaceId: 'space-id',
      slug: 'ordinary',
    })
  })
})
