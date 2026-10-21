import { expect, test } from 'bun:test'
import { createTestHubDatabaseGuard } from '../../shared/test-hub-database.ts'
import { resetFixtureStore } from './run-fixtures.ts'

test('live HUB_DB mutation: resetFixtureStore refuses before deleting', () => {
  const fakeLive = '/nonexistent-live-hub-store/hub.db'
  const previous = process.env.HUB_DB
  process.env.HUB_DB = fakeLive
  try {
    expect(() => resetFixtureStore(createTestHubDatabaseGuard())).toThrow(
      `test process refuses hub database: HUB_DB resolved ${fakeLive}`,
    )
  } finally {
    if (previous === undefined) delete process.env.HUB_DB
    else process.env.HUB_DB = previous
  }
})
