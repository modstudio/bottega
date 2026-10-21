import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existingDefaultStoreMigrationRefusal, unauthorizedHubMigrationMessage } from './db.ts'

test('an unauthorized installation cannot migrate an existing default store', () => {
  const path = '/state/hub.db'

  expect(existingDefaultStoreMigrationRefusal(false, false, path)).toBe(
    unauthorizedHubMigrationMessage(path),
  )
  expect(existingDefaultStoreMigrationRefusal(false, true, path)).toBeNull()
  expect(existingDefaultStoreMigrationRefusal(true, false, path)).toBeNull()
})

test('a linked checkout may migrate an existing temporary store', () => {
  const path = join(tmpdir(), `hub-linked-scratch-${randomUUID()}`, 'hub.db')
  expect(existingDefaultStoreMigrationRefusal(false, false, path, true)).toBeNull()
})
