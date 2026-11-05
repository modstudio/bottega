import { describe, expect, test } from 'bun:test'
import { resolvePersonalItemSpace } from './personal-item-space.ts'

const identity = {
  userId: 'user-one',
  activeSpaceId: 'organization-space',
  personalSpaceId: 'personal-space',
}

describe('resolvePersonalItemSpace', () => {
  test.each([
    [
      'user settings',
      { kind: 'document', scope: 'settings', subject: null, ownerUserId: 'user-one' },
    ],
    ['user canon', { kind: 'document', scope: 'canon', subject: null, ownerUserId: 'user-one' }],
    ['user config', { kind: 'config-entry', scope: 'user' }],
  ] as const)('%s targets the personal space', (_label, target) => {
    expect(resolvePersonalItemSpace(identity, target)).toBe('personal-space')
  })

  test.each([
    [
      'project settings',
      { kind: 'document', scope: 'settings', subject: 'project-one', ownerUserId: null },
    ],
    [
      'project canon',
      { kind: 'document', scope: 'canon', subject: 'project-one', ownerUserId: null },
    ],
    ['space config', { kind: 'config-entry', scope: 'space' }],
  ] as const)('%s retains the active space', (_label, target) => {
    expect(resolvePersonalItemSpace(identity, target)).toBe('organization-space')
  })

  test('does not treat another owner as the signed-in user personal item', () => {
    expect(
      resolvePersonalItemSpace(identity, {
        kind: 'document',
        scope: 'canon',
        subject: null,
        ownerUserId: 'user-two',
      }),
    ).toBe('organization-space')
  })
})
