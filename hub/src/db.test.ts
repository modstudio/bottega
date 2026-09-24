import { describe, expect, test } from 'bun:test'
import { PLATFORM_NAME } from '../../shared/brand.ts'
import { decideHubDatabasePath, unauthorizedHubMigrationMessage } from './db.ts'

const livePath = '/nonexistent-live-hub-store/hub.db'
const tempPath = '/nonexistent-temp-hub-store/hub.db'

describe('hub database path decision', () => {
  test('test-process unset HUB_DB mutation: refuses the live fallback', () => {
    expect(() => decideHubDatabasePath(true, undefined, livePath)).toThrow(
      `test process refuses hub database: HUB_DB resolved <unset>; live store is ${livePath}\n` +
        'invariant: A test suite never falls back to the live hub database.\n' +
        'cleared by: set HUB_DB to a scratch store before importing hub/src/db.ts',
    )
  })

  test('test-process empty HUB_DB mutation: refuses the live fallback', () => {
    expect(() => decideHubDatabasePath(true, '', livePath)).toThrow(
      'test process refuses hub database: HUB_DB resolved <unset>',
    )
  })

  test('test-process temp HUB_DB mutation: uses the scratch store', () => {
    expect(decideHubDatabasePath(true, tempPath, livePath)).toBe(tempPath)
  })

  test('non-test unset HUB_DB mutation: falls back to the live store', () => {
    expect(decideHubDatabasePath(false, undefined, livePath)).toBe(livePath)
  })

  test('non-test empty HUB_DB mutation: falls back to the live store', () => {
    expect(decideHubDatabasePath(false, '', livePath)).toBe(livePath)
  })
})

test('the unauthorized default-store migration refusal names the condition and remedy', () => {
  expect(unauthorizedHubMigrationMessage('/state/hub.db')).toBe(
    `refusing to migrate the default store: cannot establish an authorized ${PLATFORM_NAME} installation: /state/hub.db\n` +
      'invariant: A default store is created or migrated only by a checkout or an installed distribution.\n' +
      `cleared by: run hub migrate from a checkout or reinstall ${PLATFORM_NAME}`,
  )
})
