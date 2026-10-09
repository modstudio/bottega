import { describe, expect, test } from 'bun:test'
import { projectRecordDestination } from './record-project-destination.ts'

describe('project record destination', () => {
  const memberships = [
    { spaceId: 'stable-active', slug: 'active', permission: 'write' },
    { spaceId: 'stable-declared', slug: 'declared', permission: 'write' },
  ]

  test('uses the active space when the register declares none', () => {
    expect(projectRecordDestination('plain', null, 'stable-active', memberships)).toEqual({
      project: 'plain',
      spaceId: 'stable-active',
    })
  })

  test('resolves a declared slug to its stable membership id', () => {
    expect(projectRecordDestination('routed', 'declared', 'stable-active', memberships)).toEqual({
      project: 'routed',
      spaceId: 'stable-declared',
    })
  })

  test('names a declaration outside the signed-in memberships', () => {
    expect(projectRecordDestination('blocked', 'outside', 'stable-active', memberships)).toEqual({
      project: 'blocked',
      declaredSpace: 'outside',
      refused: 'declared-space-not-member',
    })
  })
})
