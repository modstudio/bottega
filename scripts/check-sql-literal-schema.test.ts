import type { Database } from 'bun:sqlite'
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { checkSqlLiteralSchemaWith, sqlFingerprint } from './check-sql-literal-schema.ts'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function fixture(
  source: string,
  options: {
    exemptions?: { fingerprint: string; reason: string }[]
    catalogue?: string[]
    migration?: string
    unjournaledMigration?: string
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'sql-schema-'))
  directories.push(directory)
  const file = join(directory, 'fixture.ts')
  writeFileSync(file, source)
  if (options.migration) writeFileSync(join(directory, '0001_fixture.sql'), options.migration)
  if (options.unjournaledMigration)
    writeFileSync(join(directory, 'orphan.sql'), options.unjournaledMigration)
  const relativeFile = relative(resolve(import.meta.dir, '..'), file)
  return () =>
    checkSqlLiteralSchemaWith({
      concerns: [
        {
          name: 'orchestrator',
          root: directory,
          migrations: options.migration
            ? { folder: directory, journal: () => [{ tag: '0001_fixture' }] }
            : null,
          migrate: (database: Database) =>
            database.exec('CREATE TABLE example (id INTEGER, name TEXT)'),
        },
      ],
      exemptions: options.exemptions?.map((item) => ({ ...item, file: relativeFile })),
      catalogues: options.catalogue
        ? { [relativeFile]: { $statements: options.catalogue } }
        : undefined,
    })
}

test.each([
  ['direct literal', "database.query('SELECT missing FROM example')"],
  ['constant-held literal', "const SQL='SELECT missing FROM example'; database.query(SQL)"],
  ['exec literal', "database.exec('SELECT missing FROM example')"],
])('%s against a missing column is refused', (_, statement) => {
  expect(fixture(statement)).toThrow('no such column: missing')
})

test('a stale exemption is refused', () => {
  expect(
    fixture("database.query('SELECT id FROM example')", {
      exemptions: [{ fingerprint: sqlFingerprint('SELECT stale FROM example'), reason: 'fixture' }],
    }),
  ).toThrow('stale SQL exemption')
})

test('different SQL at an exempt site is still checked', () => {
  expect(
    fixture("database.query('SELECT missing FROM example')", {
      exemptions: [{ fingerprint: sqlFingerprint('SELECT id FROM example'), reason: 'fixture' }],
    }),
  ).toThrow('no such column: missing')
})

test('every controlled catalogue statement is prepared', () => {
  expect(
    fixture('database.query(`SELECT $' + '{column} FROM example`)', {
      catalogue: ['SELECT id FROM example', 'SELECT missing FROM example'],
    }),
  ).toThrow('no such column: missing')
})

test('a global substitution resolves an identifier any file may interpolate', () => {
  expect(
    fixture(
      'database.query(`SELECT missing FROM example WHERE name IN $' + '{TERMINAL_RUN_STATUS_SQL}`)',
    ),
  ).toThrow('no such column: missing')
})

test('a file that declares a global substitution identifier itself is refused', () => {
  expect(
    fixture(
      [
        "const TERMINAL_RUN_STATUS_SQL = '(SELECT missing FROM example)'",
        'database.query(`SELECT id FROM example WHERE name IN $' + '{TERMINAL_RUN_STATUS_SQL}`)',
      ].join('\n'),
    ),
  ).toThrow('import TERMINAL_RUN_STATUS_SQL from orchestrator/src/run/run-status.ts')
})

test('a SQL site that guards JSON reads with a flat json_valid AND is refused', () => {
  expect(
    fixture(
      'database.query("SELECT id FROM example WHERE json_valid(name) AND json_extract(name, \'$.a\')=1")',
    ),
  ).toThrow('json_valid() cannot guard another JSON call')
  const flat = "SELECT id FROM example WHERE json_valid(name) AND json_extract(name, '$.a')=1"
  expect(
    fixture(`database.query("${flat}")`, {
      exemptions: [{ fingerprint: sqlFingerprint(flat), reason: 'prepare only' }],
    }),
  ).toThrow('json_valid() cannot guard another JSON call')
})

test('a flat JSON guard in the concern migration directory is refused', () => {
  expect(
    fixture('', {
      migration: `-- BACKFILL
UPDATE example
   SET name='seen'
 WHERE json_valid(name) AND json_extract(name, '$.state')='ready';
-- /BACKFILL
CREATE TABLE ignored (payload TEXT CHECK (json_valid(payload) AND json_type(payload)='object'));
`,
    }),
  ).toThrow('0001_fixture.sql:4: json_valid() cannot guard another JSON call')
})

test('an unjournaled SQL file is outside the migration backfill scan', () => {
  expect(
    fixture('', {
      migration: `-- BACKFILL
UPDATE example SET name='seen';
-- /BACKFILL
`,
      unjournaledMigration: `-- BACKFILL
UPDATE example
   SET name='seen'
 WHERE json_valid(name) AND json_extract(name, '$.state')='ready';
-- /BACKFILL
`,
    }),
  ).not.toThrow()
})
