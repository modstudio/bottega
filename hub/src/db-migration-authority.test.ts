import { expect, test } from 'bun:test'
import { existingDefaultStoreMigrationRefusal, unauthorizedHubMigrationMessage } from './db.ts'

test('an unauthorized installation cannot migrate an existing default store', () => {
  const path = '/state/hub.db'

  expect(existingDefaultStoreMigrationRefusal(false, false, path)).toBe(
    unauthorizedHubMigrationMessage(path),
  )
  expect(existingDefaultStoreMigrationRefusal(false, true, path)).toBeNull()
  expect(existingDefaultStoreMigrationRefusal(true, false, path)).toBeNull()
})
