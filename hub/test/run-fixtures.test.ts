import { expect, test } from 'bun:test'
import { createTestHubDatabaseGuard } from '../../shared/test-hub-database.ts'
import { resetFixtureStore } from './run-fixtures.ts'

test('live HUB_DB mutation: resetFixtureStore refuses before deleting', () => {
  const fakeLive = '/nonexistent-live-hub-store/hub.db'
  const previous = process.env.HUB_DB
  process.env.HUB_DB = fakeLive
  try {
    expect(() => resetFixtureStore(createTestHubDatabaseGuard('/unused', fakeLive))).toThrow(
      `test process refuses hub database: HUB_DB resolved ${fakeLive}; live store is ${fakeLive}\n` +
        'invariant: A test suite never falls back to the live hub database.\n' +
        'cleared by: set HUB_DB to a scratch store before importing hub/src/db.ts',
    )
  } finally {
    if (previous === undefined) delete process.env.HUB_DB
    else process.env.HUB_DB = previous
  }
})
