import { describe, expect, test } from 'bun:test'
import { decideHubDatabasePath } from './db.ts'

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

  test('test-process temp HUB_DB mutation: uses the scratch store', () => {
    expect(decideHubDatabasePath(true, tempPath, livePath)).toBe(tempPath)
  })

  test('non-test unset HUB_DB mutation: falls back to the live store', () => {
    expect(decideHubDatabasePath(false, undefined, livePath)).toBe(livePath)
  })
})
