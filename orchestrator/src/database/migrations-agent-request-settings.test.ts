import { expect, test } from 'bun:test'
import { applyMigrations, canonicalSchemaHash, expectedSchemaHash } from './migrations.ts'
import { migrationBoundaryTestDatabase } from './test-database.fixture.ts'

test('agent request settings migrate forward without changing existing registrations', () => {
  const database = migrationBoundaryTestDatabase('0220_agent_request_settings')
  database.query("UPDATE agent SET model='kept-model' WHERE name='codex'").run()

  applyMigrations(database)

  expect(canonicalSchemaHash(database)).toBe(expectedSchemaHash())
  expect(
    database.query("SELECT model,request_settings FROM agent WHERE name='codex'").get(),
  ).toEqual({ model: 'kept-model', request_settings: null })
  database
    .query("UPDATE agent SET request_settings=? WHERE name='codex'")
    .run('{"provider":{"ignore":["Morph"]}}')
  expect(database.query("SELECT request_settings FROM agent WHERE name='codex'").get()).toEqual({
    request_settings: '{"provider":{"ignore":["Morph"]}}',
  })
  expect(() =>
    database.query("UPDATE agent SET request_settings='not json' WHERE name='codex'").run(),
  ).toThrow('CHECK constraint failed')
})
