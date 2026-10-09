import { describe, expect, test } from 'bun:test'
import { recordSpaceAccessDecision, recordSpaceRequestDecision } from './record-space-request.ts'

const SPACE_A_ID = '01990000-0000-7000-8000-000000000003'
const SPACE_B_ID = '01990000-0000-7000-8000-000000000004'
const memberships = [
  { spaceId: SPACE_A_ID, slug: 'active', permission: 'read' },
  { spaceId: SPACE_B_ID, slug: 'declared', permission: 'write' },
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

test('read membership allows reads and refuses writes with a remedy', () => {
  // Production break watched: remove the write-nature permission branch.
  expect(recordSpaceAccessDecision('read', SPACE_A_ID, memberships)).toEqual({ allowed: true })
  expect(recordSpaceAccessDecision('write', SPACE_A_ID, memberships)).toEqual({
    allowed: false,
    error: `record space ${SPACE_A_ID} membership is read-only`,
    remedy: 'A space owner or admin can change the membership permission.',
  })
})

test('write membership allows writes', () => {
  // Production break watched: compare the membership permission to a value other than write.
  expect(recordSpaceAccessDecision('write', SPACE_B_ID, memberships)).toEqual({ allowed: true })
})
