import { describe, expect, test } from 'bun:test'
import { projectRecordDestination } from './record-project-destination.ts'

describe('project record destination', () => {
  const memberships = [
    { spaceId: 'stable-active', slug: 'active', permission: 'write' },
    { spaceId: 'stable-declared', slug: 'declared', permission: 'write' },
  ]

  test('refuses when the register declares none', () => {
    expect(projectRecordDestination('plain', null, memberships)).toMatchObject({
      project: 'plain', refused: 'undeclared-project',
    })
  })

  test('resolves a declared slug to its stable membership id', () => {
    expect(projectRecordDestination('routed', 'declared', memberships)).toEqual({
      project: 'routed',
      spaceId: 'stable-declared',
    })
  })

  test('names a declaration outside the signed-in memberships', () => {
    expect(projectRecordDestination('blocked', 'outside', memberships)).toMatchObject({
      project: 'blocked',
      declaredSpace: 'outside',
      refused: 'declared-space-not-member',
    })
  })
})
