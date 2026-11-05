import { expect, test } from 'bun:test'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import { currentRecordWriteDecision } from './record-write-authority.ts'

test('current write authority gathers binding and explicit-address facts', () => {
  const database = migratedTestDatabase()
  const environment = { HOME: '/tmp', BOTTEGA_HARNESS_ENV_FILE: '' }
  expect(currentRecordWriteDecision(database, environment)).toEqual({
    verdict: 'local-authoritative',
  })
  database
    .query(
      "INSERT INTO record_install_binding(id,bound_at,record_origin) VALUES (1,'2026-11-05',NULL)",
    )
    .run()
  expect(currentRecordWriteDecision(database, environment)).toMatchObject({
    verdict: 'refused',
    boundOrigin: null,
  })
  database.close()
})
