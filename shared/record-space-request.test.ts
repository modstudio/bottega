import { describe, expect, test } from 'bun:test'
import { recordSpaceRequestDecision } from './record-space-request.ts'

const SPACE_A_ID = '01990000-0000-7000-8000-000000000003'
const SPACE_B_ID = '01990000-0000-7000-8000-000000000004'
const memberships = [
  { spaceId: SPACE_A_ID, slug: 'active' },
  { spaceId: SPACE_B_ID, slug: 'declared' },
]

describe('record space request', () => {
  test('keeps the active space without a request', () => {
    expect(recordSpaceRequestDecision(null, SPACE_A_ID, memberships)).toEqual({
      allowed: true,
      spaceId: SPACE_A_ID,
    })
  })

  test('keeps a missing active space without a request', () => {
    expect(recordSpaceRequestDecision(null, null, memberships)).toEqual({
      allowed: true,
      spaceId: null,
    })
  })

  test('binds a requested member space by slug or id', () => {
    expect(recordSpaceRequestDecision('declared', SPACE_A_ID, memberships)).toEqual({
      allowed: true,
      spaceId: SPACE_B_ID,
    })
    expect(recordSpaceRequestDecision(SPACE_B_ID, SPACE_A_ID, memberships)).toEqual({
      allowed: true,
      spaceId: SPACE_B_ID,
    })
  })

  test('refuses a non-member before a tenant can be bound', () => {
    expect(recordSpaceRequestDecision('outside', SPACE_A_ID, memberships)).toEqual({
      allowed: false,
      requestedSpace: 'outside',
    })
  })
})
