import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from './brand.ts'
import {
  storeAheadMigrationRefusal,
  storeAheadOfJournalRefusal,
  storeAheadRemedy,
} from './store-ahead-remedy.ts'

test('a checkout updates to acquire the newer journal', () => {
  expect(storeAheadRemedy('checkout')).toBe(`${PLATFORM_SLUG} machine update`)
})

test('a distribution reinstalls the release that wrote the store or a later one', () => {
  expect(storeAheadRemedy('distribution')).toBe(
    `reinstall the ${PLATFORM_SLUG} release that wrote this store, or a later one, with the installer`,
  )
})

test('the refusal combines the ahead migration, invariant, and installation remedy', () => {
  expect(storeAheadOfJournalRefusal('0002_future', 'checkout', 'A schema invariant.')).toBe(
    `refusing to open a store ahead of this binary's migration journal: 0002_future\n` +
      `invariant: A schema invariant.\ncleared by: ${PLATFORM_SLUG} machine update`,
  )
})

test('the migration refusal names the installation remedy', () => {
  expect(storeAheadMigrationRefusal('0002_future', 'checkout')).toBe(
    `refusing to migrate a store ahead of this binary's migration journal: 0002_future; ` +
      `cleared by: ${PLATFORM_SLUG} machine update`,
  )
})
