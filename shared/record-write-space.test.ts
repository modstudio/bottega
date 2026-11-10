import { describe, expect, test } from 'bun:test'
import { type RecordWriteOwner, recordWriteSpace } from './record-write-space.ts'

const memberships = [{ spaceId: 'project-id', slug: 'project-space', permission: 'write' }]
const facts = {
  declaredSpaces: { fixture: 'project-space' },
  personalSpaceId: 'personal-id',
  memberships,
}

describe('recordWriteSpace', () => {
  for (const [owner, spaceId] of [
    [{ kind: 'project', name: 'fixture' }, 'project-id'],
    [{ kind: 'task', projectName: 'fixture' }, 'project-id'],
    [{ kind: 'session', checkoutProject: 'fixture' }, 'project-id'],
    [{ kind: 'session', checkoutProject: null }, 'personal-id'],
    [{ kind: 'personal' }, 'personal-id'],
    [{ kind: 'space', value: 'explicit-id' }, 'explicit-id'],
  ] as const) {
    test(`routes ${owner.kind}`, () => expect(recordWriteSpace(owner, facts)).toEqual({ spaceId }))
  }

  test.each([
    [null, 'no-owner'],
    [{ kind: 'project', name: 'missing' }, 'undeclared-project'],
    [{ kind: 'project', name: 'outside' }, 'declared-space-not-member'],
    [{ kind: 'personal' }, 'personal-space-not-provisioned'],
    [{ kind: 'space', value: null }, 'space-owner-without-value'],
  ] as const)('refuses %p', (owner, refused) => {
    const selectedFacts =
      refused === 'declared-space-not-member'
        ? { ...facts, declaredSpaces: { outside: 'outside-space' } }
        : refused === 'personal-space-not-provisioned'
          ? { ...facts, personalSpaceId: null }
          : facts
    expect(recordWriteSpace(owner as RecordWriteOwner | null, selectedFacts)).toMatchObject({
      refused,
    })
  })
})
