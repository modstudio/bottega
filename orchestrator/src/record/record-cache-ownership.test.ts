import { expect, test } from 'bun:test'
import { recordCacheAddressOwner, recordCacheSpaceOwnsAddress } from './record-cache-ownership.ts'

const projectSpaces = new Map<string, string | null>([
  ['alpha', 'space-alpha'],
  ['fallback', 'space-active'],
  ['outside', null],
])

test('project addresses use their destination while other addresses use the active space', () => {
  expect(
    recordCacheAddressOwner({
      scope: 'project',
      subject: 'alpha',
      activeSpaceId: 'space-active',
      projectSpaces,
    }),
  ).toBe('space-alpha')
  expect(
    recordCacheAddressOwner({
      scope: 'settings',
      subject: 'fallback',
      activeSpaceId: 'space-active',
      projectSpaces,
    }),
  ).toBe('space-active')
  expect(
    recordCacheAddressOwner({
      scope: 'global',
      subject: null,
      activeSpaceId: 'space-active',
      projectSpaces,
    }),
  ).toBe('space-active')
  expect(
    recordCacheAddressOwner({
      scope: 'canon',
      subject: 'outside',
      activeSpaceId: 'space-active',
      projectSpaces,
    }),
  ).toBeNull()
})

test('a pulling space may apply only documents whose address it owns', () => {
  expect(
    recordCacheSpaceOwnsAddress({
      scope: 'canon',
      subject: 'alpha',
      pullingSpaceId: 'space-alpha',
      activeSpaceId: 'space-active',
      projectSpaces,
    }),
  ).toBe(true)
  expect(
    recordCacheSpaceOwnsAddress({
      scope: 'global',
      subject: null,
      pullingSpaceId: 'space-alpha',
      activeSpaceId: 'space-active',
      projectSpaces,
    }),
  ).toBe(false)
  expect(
    recordCacheSpaceOwnsAddress({
      scope: 'project',
      subject: 'outside',
      pullingSpaceId: 'space-active',
      activeSpaceId: 'space-active',
      projectSpaces,
    }),
  ).toBe(false)
})
