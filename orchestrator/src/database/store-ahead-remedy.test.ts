import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { storeAheadRemedy } from './store-ahead-remedy.ts'

test('a checkout updates to acquire the newer journal', () => {
  expect(storeAheadRemedy('checkout')).toBe(`${PLATFORM_SLUG} machine update`)
})

test('a distribution reinstalls the release that wrote the store or a later one', () => {
  expect(storeAheadRemedy('distribution')).toBe(
    `reinstall the ${PLATFORM_SLUG} release that wrote this store, or a later one, with the installer`,
  )
})
