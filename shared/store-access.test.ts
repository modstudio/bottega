import { expect, test } from 'bun:test'
import { decideStoreAccess } from './store-access.ts'

test('a restricted worker on a shared store is immutable read-only without sidecars', () => {
  expect(
    decideStoreAccess({
      restrictedActor: true,
      storePathUnderTemporaryRoot: false,
      walOrShmSidecarPresent: false,
    }),
  ).toEqual({
    openMode: 'read-only-immutable',
    writesRefused: true,
    migrationsRefused: true,
  })
})

test('a restricted worker uses ordinary read-only mode when WAL sidecars must be read', () => {
  expect(
    decideStoreAccess({
      restrictedActor: true,
      storePathUnderTemporaryRoot: false,
      walOrShmSidecarPresent: true,
    }).openMode,
  ).toBe('read-only')
})

test('a restricted worker may write and migrate a temporary store', () => {
  expect(
    decideStoreAccess({
      restrictedActor: true,
      storePathUnderTemporaryRoot: true,
      walOrShmSidecarPresent: false,
    }),
  ).toEqual({ openMode: 'read-write', writesRefused: false, migrationsRefused: false })
})

test('an unrestricted main-checkout caller may write and migrate its store', () => {
  expect(
    decideStoreAccess({
      restrictedActor: false,
      storePathUnderTemporaryRoot: false,
      walOrShmSidecarPresent: false,
    }),
  ).toEqual({ openMode: 'read-write', writesRefused: false, migrationsRefused: false })
})
