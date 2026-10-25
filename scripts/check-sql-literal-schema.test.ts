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
  options: { exemptions?: { fingerprint: string; reason: string }[]; catalogue?: string[] } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'sql-schema-'))
  directories.push(directory)
  const file = join(directory, 'fixture.ts')
  writeFileSync(file, source)
  const relativeFile = relative(resolve(import.meta.dir, '..'), file)
  return () =>
    checkSqlLiteralSchemaWith({
      concerns: [
        {
          name: 'orchestrator',
          root: directory,
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
