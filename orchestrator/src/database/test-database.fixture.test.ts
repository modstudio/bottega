import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { applyMigrationsBefore, canonicalSchemaHash, readUserVersion } from './migrations.ts'
import { migrationBoundaryTestDatabase } from './test-database.fixture.ts'

const EARLIER_BOUNDARY = '0047_project_task_identity'
const BOUNDARY = '0048_user_canon_owner'

test('a cloned boundary image matches a fresh journal replay', () => {
  migrationBoundaryTestDatabase(EARLIER_BOUNDARY).close()
  const clone = migrationBoundaryTestDatabase(BOUNDARY)
  const replay = new Database(':memory:')
  replay.exec('PRAGMA foreign_keys=ON')
  try {
    applyMigrationsBefore(replay, BOUNDARY)

    expect(canonicalSchemaHash(clone)).toBe(canonicalSchemaHash(replay))
    expect(readUserVersion(clone)).toBe(readUserVersion(replay))
    expect(clone.query('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 })
    expect(replay.query('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 })
  } finally {
    clone.close()
    replay.close()
  }
})
