import { expect, test } from 'bun:test'
import { createTestHubDatabaseGuard } from '../../shared/test-hub-database.ts'
import { resetFixtureStore } from './run-fixtures.ts'

test('live BOTTEGA_HUB_DB mutation: resetFixtureStore refuses before deleting', () => {
  const fakeLive = '/nonexistent-live-hub-store/hub.db'
  const previous = process.env.BOTTEGA_HUB_DB
  process.env.BOTTEGA_HUB_DB = fakeLive
  try {
    expect(() => resetFixtureStore(createTestHubDatabaseGuard())).toThrow(
      `test process refuses hub database: BOTTEGA_HUB_DB resolved ${fakeLive}`,
    )
  } finally {
    if (previous === undefined) delete process.env.BOTTEGA_HUB_DB
    else process.env.BOTTEGA_HUB_DB = previous
  }
})
