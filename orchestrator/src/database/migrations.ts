import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const MIGRATIONS_FOLDER = join(import.meta.dir, '..', '..', 'migrations')
const MIGRATIONS_TABLE = 'orch_migrations'
export const SCHEMA_LOCK_TABLE = 'orch_schema_lock'
const SCHEMA_INVARIANT = "Only the main checkout's binary migrates the store."
export const CONNECTION_SCHEMA_INVARIANT = 'A process writes only the schema version it opened.'
export const JOURNAL_WHEN_ORDER = 'migration journal when values must be strictly increasing'
const BACKFILL_UNCLOSED = 'migration backfill blocks must be closed by -- /BACKFILL'

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
  indexSql: string | null
}
type ViewShape = { name: string; sql: string | null }
type TriggerShape = { name: string; table: string; sql: string | null }
type SchemaInventory = {
  tables: string[]
  columns: ColumnShape[]
  foreignKeys: ForeignKeyShape[]
  indexes: IndexShape[]
  checks: { table: string; expression: string }[]
  views: ViewShape[]
  triggers: TriggerShape[]
}

export function migrationJournal(folder = MIGRATIONS_FOLDER): JournalEntry[] {
  const journal = JSON.parse(readFileSync(join(folder, 'meta', '_journal.json'), 'utf8')) as {
    entries: JournalEntry[]
  }
  const entries = journal.entries
  for (let i = 1; i < entries.length; i++) {
    const previous = entries[i - 1]!
    const current = entries[i]!
    if (current.when <= previous.when) {
      throw new Error(
        `refusing to load a migration journal whose when values are not strictly increasing\n` +
          `invariant: ${JOURNAL_WHEN_ORDER}\n` +
          `${previous.tag}@${previous.when} then ${current.tag}@${current.when}`,
      )
    }
  }
  return entries
}

function migrationSource(entry: JournalEntry, folder = MIGRATIONS_FOLDER): string {
  return readFileSync(join(folder, `${entry.tag}.sql`), 'utf8')
}

/** DDL for hashing and one-time apply; backfill blocks are excluded so they can evolve. */
export function splitMigrationSource(source: string): { ddl: string; backfill: string } {
  const opens = source.match(/^[ \t]*--[ \t]*BACKFILL[ \t]*$/gm) ?? []
  const closes = source.match(/^[ \t]*--[ \t]*\/BACKFILL[ \t]*$/gm) ?? []
  if (opens.length !== closes.length) {
    throw new Error(
      `refusing to load a migration whose backfill block is not closed\n` +
        `invariant: ${BACKFILL_UNCLOSED}`,
    )
  }
  const blocks: string[] = []
  const ddl = source.replace(
    /^[ \t]*--[ \t]*BACKFILL[ \t]*\r?\n([\s\S]*?)^[ \t]*--[ \t]*\/BACKFILL[ \t]*\r?\n?/gm,
    (_match, body: string) => {
      blocks.push(body)
      return ''
    },
  )
  return { ddl, backfill: blocks.join('\n') }
}

function migrationHash(entry: JournalEntry, folder = MIGRATIONS_FOLDER): string {
  return createHash('sha256')
    .update(splitMigrationSource(migrationSource(entry, folder)).ddl)
    .digest('hex')
}

export function readUserVersion(d: Database): number {
  return (d.query('PRAGMA user_version').get() as { user_version: number }).user_version
}

function stampUserVersion(d: Database, version: number): void {
  if (!Number.isInteger(version) || version < 0) throw new Error(`invalid user_version ${version}`)
  d.exec(`PRAGMA user_version = ${version}`)
}

export function schemaVersionLabel(d: Database): string {
  const version = readUserVersion(d)
  if (version === 0) return 'unstamped'
  return String(version)
}

export function staleWriteRefusal(actual: number, opened: number, clearedBy: string): string {
  return (
    `refusing to write: the store schema is newer than this process (user_version ${actual}, opened ${opened})\n` +
    `invariant: ${CONNECTION_SCHEMA_INVARIANT}\ncleared by: ${clearedBy}`
  )
}

function tableExists(d: Database, table: string): boolean {
  return !!d.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)
}

function migrationState(
  d: Database,
  folder = MIGRATIONS_FOLDER,
): { pending: JournalEntry[]; ahead: string | null } {
  const journal = migrationJournal(folder)
  if (!tableExists(d, MIGRATIONS_TABLE)) return { pending: journal, ahead: null }
  const applied = d
    .query(`SELECT hash, created_at, version FROM ${MIGRATIONS_TABLE} ORDER BY created_at`)
    .all() as { hash: string; created_at: number; version: string | null }[]
  const expected = new Map(journal.map((entry) => [entry.when, migrationHash(entry, folder)]))
  const ahead = applied.find((row) => expected.get(Number(row.created_at)) !== row.hash)
  return {
    pending: journal.filter(
      (entry) =>
        !applied.some(
          (row) => Number(row.created_at) === entry.when && row.hash === expected.get(entry.when),
        ),
    ),
    ahead: ahead
      ? (ahead.version ?? String(ahead.created_at))
      : applied.length > journal.length
        ? (applied.at(-1)?.version ?? String(applied.at(-1)?.created_at))
        : null,
  }
}

export function migrationRefusal(d: Database): string | null {
  const state = migrationState(d)
  if (state.ahead) {
    return (
      `refusing to open a store ahead of this binary's migration journal: ${state.ahead}\n` +
      `invariant: ${SCHEMA_INVARIANT}\ncleared by: orch migrate`
    )
  }
  if (state.pending.length) {
    return (
      `refusing to open a store behind this binary's migration journal: ${state.pending[0]!.tag}\n` +
      `invariant: ${SCHEMA_INVARIANT}\ncleared by: orch migrate`
    )
  }
  return null
}

/** Match trunk's schemaVersion canonicalisation: identifier quotes and whitespace are immaterial. */
function normalizeSql(source: string): string {
  return source
    .replace(
      /"([A-Za-z_][A-Za-z0-9_]*)"|`([A-Za-z_][A-Za-z0-9_]*)`|\[([A-Za-z_][A-Za-z0-9_]*)\]/g,
      (
        _match,
        quoted: string | undefined,
        backticked: string | undefined,
        bracketed: string | undefined,
      ) => quoted ?? backticked ?? bracketed ?? '',
    )
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Strip SQL comments outside string literals. A regex strip corrupts a quoted
 * '--' or '/*', and the stripped text is what reaches exec, so the walk has to
 * know where strings are. Single-quoted literals with '' escapes are the only
 * string form these journals use.
 */
export function stripSqlComments(source: string): string {
  let result = ''
  let inString = false
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!
    if (inString) {
      result += char
      if (char === "'") {
        if (source[i + 1] === "'") result += source[++i]!
        else inString = false
      }
      continue
    }
    if (char === "'") {
      inString = true
      result += char
      continue
    }
    if (char === '-' && source[i + 1] === '-') {
      const end = source.indexOf('\n', i)
      if (end === -1) break
      i = end - 1
      continue
    }
    if (char === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2)
      if (end === -1) break
      i = end + 1
      continue
    }
    result += char
  }
  return result
}

function withoutSqlComments(source: string): string {
  return stripSqlComments(source)
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
    if (depth !== 0)
      throw new Error(
        `unterminated CHECK expression: ${source.slice(match.index, match.index + 80)}`,
      )
    expressions.push(normalizeExpression(sql.slice(start, end - 1)))
    check.lastIndex = end
  }
  return expressions.sort()
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

function schemaInventory(d: Database): SchemaInventory {
  const tableRows = d
    .query(
      `SELECT name, sql FROM sqlite_master
     WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN (?, ?)
     ORDER BY name`,
    )
    .all(MIGRATIONS_TABLE, SCHEMA_LOCK_TABLE) as { name: string; sql: string }[]
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
    foreignKeys.push(
      ...fks.map((row) => ({
        table: table.name,
        id: row.id,
        sequence: row.seq,
        targetTable: row.table,
        from: row.from,
        to: row.to,
        onUpdate: row.on_update.toLowerCase(),
        onDelete: row.on_delete.toLowerCase(),
        match: row.match.toLowerCase(),
      })),
    )
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
      // sqlite_autoindex rows have no SQL. Every explicit index does: include
      // it even when index_info names ordinary columns, because direction and
      // collation are not present in that PRAGMA.
      const sql =
        (
          d
            .query("SELECT sql FROM sqlite_master WHERE type='index' AND name=?")
            .get(index.name) as { sql: string | null } | null
        )?.sql ?? null
      indexes.push({
        table: table.name,
        name: index.name,
        unique: index.unique,
        origin: index.origin.toLowerCase(),
        partial: index.partial,
        columns: info
          .sort((a, b) => a.seqno - b.seqno)
          .map((row) => `${row.cid}:${row.name ?? '<expression>'}`)
          .join(','),
        indexSql: sql == null ? null : normalizeExpression(normalizeSql(withoutSqlComments(sql))),
      })
    }
    for (const expression of checkExpressions(table.sql))
      checks.push({ table: table.name, expression })
  }
  const views = (
    d
      .query(
        `SELECT name, sql FROM sqlite_master WHERE type='view' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all() as { name: string; sql: string | null }[]
  ).map((row) => ({
    name: row.name,
    sql: row.sql == null ? null : normalizeExpression(normalizeSql(withoutSqlComments(row.sql))),
  }))
  const triggers = (
    d
      .query(
        `SELECT name, tbl_name, sql FROM sqlite_master
     WHERE type='trigger' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all() as { name: string; tbl_name: string; sql: string | null }[]
  ).map((row) => ({
    name: row.name,
    table: row.tbl_name,
    sql: row.sql == null ? null : normalizeExpression(normalizeSql(withoutSqlComments(row.sql))),
  }))
  foreignKeys.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  indexes.sort((a, b) => a.table.localeCompare(b.table) || a.name.localeCompare(b.name))
  checks.sort((a, b) => a.table.localeCompare(b.table) || a.expression.localeCompare(b.expression))
  return { tables, columns, foreignKeys, indexes, checks, views, triggers }
}

function inventoryLines(inventory: SchemaInventory): string[] {
  return [
    ...inventory.tables.map((table) => `table ${table}`),
    ...inventory.columns.map(
      (row) =>
        `column ${row.table}.${row.name} ${row.type} notnull=${row.notnull} default=${row.defaultValue ?? 'NULL'} pk=${row.primaryKey}`,
    ),
    ...inventory.foreignKeys.map((row) => `foreign-key ${JSON.stringify(row)}`),
    ...inventory.indexes.map((row) => `index ${JSON.stringify(row)}`),
    ...inventory.checks.map((row) => `check ${row.table} ${row.expression}`),
    ...inventory.views.map((row) => `view ${row.name} ${row.sql ?? 'NULL'}`),
    ...inventory.triggers.map((row) => `trigger ${row.table}.${row.name} ${row.sql ?? 'NULL'}`),
  ]
}

export function canonicalSchemaHash(d: Database): string {
  return createHash('sha256')
    .update(inventoryLines(schemaInventory(d)).join('\n'))
    .digest('hex')
}

function executeStatements(d: Database, source: string): void {
  for (const statement of source.split('--> statement-breakpoint')) {
    const executable = stripSqlComments(statement).trim()
    if (executable) d.exec(executable)
  }
}

function executeMigrationSource(d: Database, source: string): void {
  executeStatements(d, splitMigrationSource(source).ddl)
}

function applyBackfills(d: Database, folder: string): void {
  for (const entry of migrationJournal(folder)) {
    const backfill = splitMigrationSource(migrationSource(entry, folder)).backfill
    if (backfill.trim()) executeStatements(d, backfill)
  }
}

const expectedSchemaHashes = new Map<string, string>()

/** Hash the schema produced by the complete journal, not only its adoption baseline. */
export function expectedSchemaHash(folder = MIGRATIONS_FOLDER): string {
  const cached = expectedSchemaHashes.get(folder)
  if (cached) return cached
  const d = new Database(':memory:')
  try {
    for (const entry of migrationJournal(folder)) {
      executeMigrationSource(d, migrationSource(entry, folder))
    }
    const hash = canonicalSchemaHash(d)
    expectedSchemaHashes.set(folder, hash)
    return hash
  } finally {
    d.close()
  }
}

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
  const checkKey = (row: { table: string; expression: string }) =>
    `check ${row.table} ${row.expression}`
  const actualChecks = shape(actual.checks.map(checkKey))
  const expectedChecks = shape(expected.checks.map(checkKey))
  const foreignKeyKey = (row: ForeignKeyShape) => `foreign-key ${JSON.stringify(row)}`
  const actualForeignKeys = shape(actual.foreignKeys.map(foreignKeyKey))
  const expectedForeignKeys = shape(expected.foreignKeys.map(foreignKeyKey))
  const viewKey = (row: ViewShape) => `view ${row.name} ${row.sql ?? 'NULL'}`
  const actualViews = shape(actual.views.map(viewKey))
  const expectedViews = shape(expected.views.map(viewKey))
  const triggerKey = (row: TriggerShape) => `trigger ${row.table}.${row.name} ${row.sql ?? 'NULL'}`
  const actualTriggers = shape(actual.triggers.map(triggerKey))
  const expectedTriggers = shape(expected.triggers.map(triggerKey))
  const difference = (left: string[], right: string[]) =>
    left.filter((value) => !right.includes(value))
  return [
    `missing tables: ${difference(expectedTables, actualTables).join(', ') || 'none'}`,
    `unexpected tables: ${difference(actualTables, expectedTables).join(', ') || 'none'}`,
    `missing columns: ${difference(expectedColumns, actualColumns).join(', ') || 'none'}`,
    `unexpected columns: ${difference(actualColumns, expectedColumns).join(', ') || 'none'}`,
    `missing indexes: ${difference(expectedIndexes, actualIndexes).join(', ') || 'none'}`,
    `unexpected indexes: ${difference(actualIndexes, expectedIndexes).join(', ') || 'none'}`,
    `missing checks: ${difference(expectedChecks, actualChecks).join(', ') || 'none'}`,
    `unexpected checks: ${difference(actualChecks, expectedChecks).join(', ') || 'none'}`,
    `missing foreign-keys: ${difference(expectedForeignKeys, actualForeignKeys).join(', ') || 'none'}`,
    `unexpected foreign-keys: ${difference(actualForeignKeys, expectedForeignKeys).join(', ') || 'none'}`,
    `missing views: ${difference(expectedViews, actualViews).join(', ') || 'none'}`,
    `unexpected views: ${difference(actualViews, expectedViews).join(', ') || 'none'}`,
    `missing triggers: ${difference(expectedTriggers, actualTriggers).join(', ') || 'none'}`,
    `unexpected triggers: ${difference(actualTriggers, expectedTriggers).join(', ') || 'none'}`,
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

function ensureSchemaLock(d: Database): void {
  d.exec(`CREATE TABLE IF NOT EXISTS ${SCHEMA_LOCK_TABLE} (
    id INTEGER PRIMARY KEY CHECK (id = 1)
  )`)
  d.exec(`INSERT OR IGNORE INTO ${SCHEMA_LOCK_TABLE} (id) VALUES (1)`)
}

function recordMigration(d: Database, entry: JournalEntry, folder: string): void {
  d.query(`INSERT INTO ${MIGRATIONS_TABLE} (hash,created_at,version) VALUES (?,?,?)`).run(
    migrationHash(entry, folder),
    entry.when,
    entry.tag,
  )
}

function adoptBaseline(d: Database, folder: string): string[] {
  if (tableExists(d, MIGRATIONS_TABLE)) return []
  const applicationObjects = (
    d
      .query(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT IN (?, ?)",
      )
      .get(MIGRATIONS_TABLE, SCHEMA_LOCK_TABLE) as { n: number }
  ).n
  if (applicationObjects === 0) return []
  const actualInventory = schemaInventory(d)
  const expectedInventory = baselineInventory(folder)
  const storedHash = canonicalSchemaHash(d)
  const expectedHash = createHash('sha256')
    .update(inventoryLines(expectedInventory).join('\n'))
    .digest('hex')
  if (storedHash !== expectedHash) {
    throw new Error(
      `refusing to adopt migration baseline: the existing store does not match it\n` +
        `stored hash: ${storedHash}\nexpected hash: ${expectedHash}\n` +
        `${inventoryDiff(actualInventory, expectedInventory)}\n` +
        `back up the store and run the old binary's open once`,
    )
  }
  const entry = migrationJournal(folder)[0]!
  createMigrationsTable(d)
  recordMigration(d, entry, folder)
  stampUserVersion(d, entry.idx + 1)
  return [entry.tag]
}

/** Apply pending journal entries and re-run backfills under one IMMEDIATE lock. */
export function applyMigrations(d: Database, folder = MIGRATIONS_FOLDER): string[] {
  d.exec('PRAGMA busy_timeout = 15000')
  d.exec('BEGIN IMMEDIATE')
  try {
    ensureSchemaLock(d)
    d.exec(`UPDATE ${SCHEMA_LOCK_TABLE} SET id = 1 WHERE id = 1`)
    const versions = adoptBaseline(d, folder)
    const state = migrationState(d, folder)
    if (state.ahead) {
      throw new Error(
        `refusing to migrate a store ahead of this binary's migration journal: ${state.ahead}`,
      )
    }
    for (const entry of state.pending) {
      createMigrationsTable(d)
      executeMigrationSource(d, migrationSource(entry, folder))
      recordMigration(d, entry, folder)
      stampUserVersion(d, entry.idx + 1)
      versions.push(entry.tag)
    }
    applyBackfills(d, folder)
    stampUserVersion(d, migrationJournal(folder).length)
    d.exec('COMMIT')
    return versions
  } catch (error) {
    try {
      d.exec('ROLLBACK')
    } catch {
      /* statement error already aborted the transaction */
    }
    throw error
  }
}
