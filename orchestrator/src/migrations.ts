import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const MIGRATIONS_FOLDER = join(import.meta.dir, '..', 'migrations')
export const MIGRATIONS_TABLE = 'orch_migrations'
export const SCHEMA_INVARIANT = 'Only the main checkout\'s binary migrates the store.'

type JournalEntry = { idx: number; when: number; tag: string }
type ColumnShape = {
  table: string
  name: string
  type: string
  notnull: number
  defaultValue: string | null
  primaryKey: number
}
type ForeignKeyShape = {
  table: string
  id: number
  sequence: number
  targetTable: string
  from: string
  to: string | null
  onUpdate: string
  onDelete: string
  match: string
}
type IndexShape = {
  table: string
  name: string
  unique: number
  origin: string
  partial: number
  columns: string
  specialSql: string | null
}
type SchemaInventory = {
  tables: string[]
  columns: ColumnShape[]
  foreignKeys: ForeignKeyShape[]
  indexes: IndexShape[]
  checks: { table: string; expression: string }[]
}

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

function withoutSqlComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '')
}

/** Ignore SQL case and whitespace outside string literals, whose values remain case-sensitive. */
function normalizeExpression(source: string): string {
  let result = ''
  let inString = false
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!
    if (char === "'") {
      result += char
      if (inString && source[i + 1] === "'") result += source[++i]!
      else inString = !inString
    } else if (inString) result += char
    else if (!/\s/.test(char)) result += char.toLowerCase()
  }
  return result
}

function checkExpressions(source: string): string[] {
  const sql = withoutSqlComments(source)
  const expressions: string[] = []
  const check = /\bcheck\s*\(/gi
  for (let match = check.exec(sql); match; match = check.exec(sql)) {
    const start = check.lastIndex
    let depth = 1
    let inString = false
    let end = start
    for (; end < sql.length && depth > 0; end++) {
      const char = sql[end]!
      if (char === "'") {
        if (inString && sql[end + 1] === "'") end++
        else inString = !inString
      } else if (!inString && char === '(') depth++
      else if (!inString && char === ')') depth--
    }
    if (depth !== 0) throw new Error(`unterminated CHECK expression: ${source.slice(match.index, match.index + 80)}`)
    expressions.push(normalizeExpression(sql.slice(start, end - 1)))
    check.lastIndex = end
  }
  return expressions.sort()
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

function schemaInventory(d: Database): SchemaInventory {
  const tableRows = d.query(
    `SELECT name, sql FROM sqlite_master
     WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>?
     ORDER BY name`,
  ).all(MIGRATIONS_TABLE) as { name: string; sql: string }[]
  const tables = tableRows.map((row) => row.name).sort()
  const columns: ColumnShape[] = []
  const foreignKeys: ForeignKeyShape[] = []
  const indexes: IndexShape[] = []
  const checks: { table: string; expression: string }[] = []
  for (const table of tableRows) {
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
        type: normalizeSql(row.type).toLowerCase(),
        notnull: row.notnull,
        defaultValue: row.dflt_value == null ? null : normalizeExpression(row.dflt_value),
        primaryKey: row.pk,
      })
    }
    columns.sort((a, b) => a.table.localeCompare(b.table) || a.name.localeCompare(b.name))
    const fks = d.query(`PRAGMA foreign_key_list(${quoteIdentifier(table.name)})`).all() as {
      id: number
      seq: number
      table: string
      from: string
      to: string | null
      on_update: string
      on_delete: string
      match: string
    }[]
    foreignKeys.push(...fks.map((row) => ({
      table: table.name, id: row.id, sequence: row.seq, targetTable: row.table,
      from: row.from, to: row.to, onUpdate: row.on_update.toLowerCase(),
      onDelete: row.on_delete.toLowerCase(), match: row.match.toLowerCase(),
    })))
    const listed = d.query(`PRAGMA index_list(${quoteIdentifier(table.name)})`).all() as {
      name: string
      unique: number
      origin: string
      partial: number
    }[]
    for (const index of listed) {
      const info = d.query(`PRAGMA index_info(${quoteIdentifier(index.name)})`).all() as {
        seqno: number
        cid: number
        name: string | null
      }[]
      const expression = info.some((row) => row.cid === -2 || row.name === null)
      const sql = expression || index.partial
        ? (d.query("SELECT sql FROM sqlite_master WHERE type='index' AND name=?").get(index.name) as
          { sql: string | null } | null)?.sql ?? null
        : null
      indexes.push({
        table: table.name, name: index.name, unique: index.unique,
        origin: index.origin.toLowerCase(), partial: index.partial,
        columns: info.sort((a, b) => a.seqno - b.seqno)
          .map((row) => `${row.cid}:${row.name ?? '<expression>'}`).join(','),
        specialSql: sql == null ? null : normalizeExpression(normalizeSql(withoutSqlComments(sql))),
      })
    }
    for (const expression of checkExpressions(table.sql)) checks.push({ table: table.name, expression })
  }
  foreignKeys.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  indexes.sort((a, b) => a.table.localeCompare(b.table) || a.name.localeCompare(b.name))
  checks.sort((a, b) => a.table.localeCompare(b.table) || a.expression.localeCompare(b.expression))
  return { tables, columns, foreignKeys, indexes, checks }
}

function inventoryLines(inventory: SchemaInventory): string[] {
  return [
    ...inventory.tables.map((table) => `table ${table}`),
    ...inventory.columns.map((row) =>
      `column ${row.table}.${row.name} ${row.type} notnull=${row.notnull} default=${row.defaultValue ?? 'NULL'} pk=${row.primaryKey}`),
    ...inventory.foreignKeys.map((row) => `foreign-key ${JSON.stringify(row)}`),
    ...inventory.indexes.map((row) => `index ${JSON.stringify(row)}`),
    ...inventory.checks.map((row) => `check ${row.table} ${row.expression}`),
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
  const actualTables = shape(actual.tables)
  const expectedTables = shape(expected.tables)
  const columnKey = (row: ColumnShape) =>
    `${row.table}.${row.name} ${row.type} notnull=${row.notnull} default=${row.defaultValue ?? 'NULL'} pk=${row.primaryKey}`
  const actualColumns = shape(actual.columns.map(columnKey))
  const expectedColumns = shape(expected.columns.map(columnKey))
  const indexKey = (row: IndexShape) => `${row.table}.${row.name} ${JSON.stringify(row)}`
  const actualIndexes = shape(actual.indexes.map(indexKey))
  const expectedIndexes = shape(expected.indexes.map(indexKey))
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
