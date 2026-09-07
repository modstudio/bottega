import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const MIGRATIONS_FOLDER = join(import.meta.dir, '..', 'migrations')
export const MIGRATIONS_TABLE = 'orch_migrations'
export const SCHEMA_INVARIANT = 'Only the main checkout\'s binary migrates the store.'

type JournalEntry = { idx: number; when: number; tag: string }
type SchemaObject = { type: 'table' | 'index'; name: string; sql: string }
type ColumnShape = {
  table: string
  name: string
  type: string
  notnull: number
  defaultValue: string | null
  primaryKey: number
}
type SchemaInventory = { objects: SchemaObject[]; columns: ColumnShape[] }

export function migrationJournal(folder = MIGRATIONS_FOLDER): JournalEntry[] {
  const journal = JSON.parse(readFileSync(join(folder, 'meta', '_journal.json'), 'utf8')) as
    { entries: JournalEntry[] }
  return journal.entries
}

function migrationSource(entry: JournalEntry, folder = MIGRATIONS_FOLDER): string {
  return readFileSync(join(folder, `${entry.tag}.sql`), 'utf8')
}

function migrationHash(entry: JournalEntry, folder = MIGRATIONS_FOLDER): string {
  return createHash('sha256').update(migrationSource(entry, folder)).digest('hex')
}

function tableExists(d: Database, table: string): boolean {
  return !!d.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)
}

export function migrationState(
  d: Database,
  folder = MIGRATIONS_FOLDER,
): { pending: JournalEntry[]; ahead: string | null } {
  const journal = migrationJournal(folder)
  if (!tableExists(d, MIGRATIONS_TABLE)) return { pending: journal, ahead: null }
  const applied = d.query(
    `SELECT hash, created_at, version FROM ${MIGRATIONS_TABLE} ORDER BY created_at`,
  ).all() as { hash: string; created_at: number; version: string | null }[]
  const expected = new Map(journal.map((entry) => [entry.when, migrationHash(entry, folder)]))
  const latestJournal = journal.at(-1)
  const ahead = applied.find((row) => expected.get(Number(row.created_at)) !== row.hash)
  return {
    pending: journal.filter((entry) => !applied.some((row) =>
      Number(row.created_at) === entry.when && row.hash === expected.get(entry.when))),
    ahead: ahead ? ahead.version ?? String(ahead.created_at) :
      applied.some((row) => Number(row.created_at) > (latestJournal?.when ?? -1))
        ? applied.at(-1)?.version ?? String(applied.at(-1)?.created_at) : null,
  }
}

export function migrationRefusal(d: Database): string | null {
  const state = migrationState(d)
  if (state.ahead) {
    return `refusing to open a store ahead of this binary's migration journal: ${state.ahead}\n` +
      `invariant: ${SCHEMA_INVARIANT}\ncleared by: orch migrate`
  }
  if (state.pending.length) {
    return `refusing to open a store behind this binary's migration journal: ${state.pending[0]!.tag}\n` +
      `invariant: ${SCHEMA_INVARIANT}\ncleared by: orch migrate`
  }
  return null
}

/** Match trunk's schemaVersion canonicalisation: identifier quotes and whitespace are immaterial. */
function normalizeSql(source: string): string {
  return source
    .replace(/"([A-Za-z_][A-Za-z0-9_]*)"|`([A-Za-z_][A-Za-z0-9_]*)`|\[([A-Za-z_][A-Za-z0-9_]*)\]/g,
      (_match, quoted: string | undefined, backticked: string | undefined,
        bracketed: string | undefined) => quoted ?? backticked ?? bracketed ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

function schemaInventory(d: Database): SchemaInventory {
  const objects = (d.query(
    `SELECT type, name, sql FROM sqlite_master
     WHERE type IN ('table','index') AND sql IS NOT NULL
       AND name NOT LIKE 'sqlite_%' AND name<>?
     ORDER BY type, name`,
  ).all(MIGRATIONS_TABLE) as SchemaObject[]).map((row) => ({ ...row, sql: normalizeSql(row.sql) }))
  const columns: ColumnShape[] = []
  for (const table of objects.filter((row) => row.type === 'table')) {
    const rows = d.query(`PRAGMA table_info(${quoteIdentifier(table.name)})`).all() as {
      name: string
      type: string
      notnull: number
      dflt_value: string | null
      pk: number
    }[]
    for (const row of rows) {
      columns.push({
        table: table.name,
        name: row.name,
        type: normalizeSql(row.type),
        notnull: row.notnull,
        defaultValue: row.dflt_value == null ? null : normalizeSql(row.dflt_value),
        primaryKey: row.pk,
      })
    }
  }
  return { objects, columns }
}

function inventoryLines(inventory: SchemaInventory): string[] {
  return [
    ...inventory.objects.map((row) => `${row.type} ${row.name} ${row.sql}`),
    ...inventory.columns.map((row) =>
      `column ${row.table}.${row.name} ${row.type} notnull=${row.notnull} default=${row.defaultValue ?? 'NULL'} pk=${row.primaryKey}`),
  ]
}

export function canonicalSchemaHash(d: Database): string {
  return createHash('sha256').update(inventoryLines(schemaInventory(d)).join('\n')).digest('hex')
}

function executeMigrationSource(d: Database, source: string): void {
  for (const statement of source.split('--> statement-breakpoint')) {
    if (statement.trim()) d.exec(statement)
  }
}

export function baselineSchemaHash(folder = MIGRATIONS_FOLDER): string {
  const baseline = migrationJournal(folder)[0]!
  const d = new Database(':memory:')
  try {
    executeMigrationSource(d, migrationSource(baseline, folder))
    return canonicalSchemaHash(d)
  } finally {
    d.close()
  }
}

export const BASELINE_SCHEMA_HASH = baselineSchemaHash()

function shape(values: string[]): string[] {
  return [...values].sort()
}

function inventoryDiff(actual: SchemaInventory, expected: SchemaInventory): string {
  const actualTables = shape(actual.objects.filter((row) => row.type === 'table').map((row) => row.name))
  const expectedTables = shape(expected.objects.filter((row) => row.type === 'table').map((row) => row.name))
  const columnKey = (row: ColumnShape) =>
    `${row.table}.${row.name} ${row.type} notnull=${row.notnull} default=${row.defaultValue ?? 'NULL'} pk=${row.primaryKey}`
  const actualColumns = shape(actual.columns.map(columnKey))
  const expectedColumns = shape(expected.columns.map(columnKey))
  const indexKey = (row: SchemaObject) => `${row.name} ${row.sql}`
  const actualIndexes = shape(actual.objects.filter((row) => row.type === 'index').map(indexKey))
  const expectedIndexes = shape(expected.objects.filter((row) => row.type === 'index').map(indexKey))
  const difference = (left: string[], right: string[]) => left.filter((value) => !right.includes(value))
  return [
    `missing tables: ${difference(expectedTables, actualTables).join(', ') || 'none'}`,
    `unexpected tables: ${difference(actualTables, expectedTables).join(', ') || 'none'}`,
    `missing columns: ${difference(expectedColumns, actualColumns).join(', ') || 'none'}`,
    `unexpected columns: ${difference(actualColumns, expectedColumns).join(', ') || 'none'}`,
    `missing indexes: ${difference(expectedIndexes, actualIndexes).join(', ') || 'none'}`,
    `unexpected indexes: ${difference(actualIndexes, expectedIndexes).join(', ') || 'none'}`,
  ].join('\n')
}

function baselineInventory(folder = MIGRATIONS_FOLDER): SchemaInventory {
  const baseline = migrationJournal(folder)[0]!
  const d = new Database(':memory:')
  try {
    executeMigrationSource(d, migrationSource(baseline, folder))
    return schemaInventory(d)
  } finally {
    d.close()
  }
}

function createMigrationsTable(d: Database): void {
  d.exec(`CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hash TEXT NOT NULL,
    created_at NUMERIC,
    version TEXT
  )`)
}

function recordMigration(d: Database, entry: JournalEntry, folder: string): void {
  d.query(`INSERT INTO ${MIGRATIONS_TABLE} (hash,created_at,version) VALUES (?,?,?)`)
    .run(migrationHash(entry, folder), entry.when, entry.tag)
}

function adoptBaseline(d: Database, folder: string): string[] {
  if (tableExists(d, MIGRATIONS_TABLE)) return []
  const applicationTables = (d.query(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
  ).get() as { n: number }).n
  if (applicationTables === 0) return []
  const actualInventory = schemaInventory(d)
  const expectedInventory = baselineInventory(folder)
  const storedHash = canonicalSchemaHash(d)
  const expectedHash = createHash('sha256').update(inventoryLines(expectedInventory).join('\n')).digest('hex')
  if (storedHash !== expectedHash) {
    throw new Error(
      `refusing to adopt migration baseline: the existing store does not match it\n` +
      `stored hash: ${storedHash}\nexpected hash: ${expectedHash}\n` +
      `${inventoryDiff(actualInventory, expectedInventory)}\n` +
      `back up the store and run the old binary's open once`,
    )
  }
  const entry = migrationJournal(folder)[0]!
  d.exec('BEGIN IMMEDIATE')
  try {
    createMigrationsTable(d)
    recordMigration(d, entry, folder)
    d.exec('COMMIT')
  } catch (error) {
    d.exec('ROLLBACK')
    throw error
  }
  return [entry.tag]
}

/** Apply each pending checksummed journal entry in its own IMMEDIATE transaction. */
export function applyMigrations(d: Database, folder = MIGRATIONS_FOLDER): string[] {
  const versions = adoptBaseline(d, folder)
  const state = migrationState(d, folder)
  if (state.ahead) {
    throw new Error(`refusing to migrate a store ahead of this binary's migration journal: ${state.ahead}`)
  }
  for (const entry of state.pending) {
    d.exec('BEGIN IMMEDIATE')
    try {
      createMigrationsTable(d)
      executeMigrationSource(d, migrationSource(entry, folder))
      recordMigration(d, entry, folder)
      d.exec('COMMIT')
      versions.push(entry.tag)
    } catch (error) {
      d.exec('ROLLBACK')
      throw error
    }
  }
  return versions
}
