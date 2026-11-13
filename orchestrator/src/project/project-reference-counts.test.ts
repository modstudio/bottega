import { expect, test } from 'bun:test'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import { PROJECT_REFERENCE_REPORT } from './project-reference-counts.ts'

test('registers every foreign key targeting project(record_id)', () => {
  const database = migratedTestDatabase()
  const registered = new Set(
    PROJECT_REFERENCE_REPORT.map(
      ([key, , column, explicitTable]) => `${explicitTable ?? key}.${column}`,
    ),
  )
  const missing = database
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .flatMap(({ name }) =>
      database
        .query<{ table: string; from: string; to: string }, []>(
          `PRAGMA foreign_key_list('${name}')`,
        )
        .all()
        .filter((foreignKey) => foreignKey.table === 'project' && foreignKey.to === 'record_id')
        .map((foreignKey) => `${name}.${foreignKey.from}`),
    )
    .filter((reference) => !registered.has(reference))

  expect(missing).toEqual([])
  database.close()
})
