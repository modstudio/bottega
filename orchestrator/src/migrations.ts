import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import type { MigrationMeta } from 'drizzle-orm/migrator'
import { sql } from 'drizzle-orm'

export const MIGRATIONS_FOLDER = join(import.meta.dir, '..', 'migrations')
export const MIGRATIONS_TABLE = 'orch_migrations'
export const SCHEMA_INVARIANT = 'Only the main checkout\'s binary migrates the store.'

type JournalEntry = { idx: number; when: number; tag: string }

export function migrationJournal(): JournalEntry[] {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')) as
    { entries: JournalEntry[] }
  return journal.entries
}

function tableExists(d: Database, table: string): boolean {
  return !!d.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)
}

export function migrationState(d: Database): { pending: JournalEntry[]; ahead: string | null } {
  const journal = migrationJournal()
  if (!tableExists(d, MIGRATIONS_TABLE)) return { pending: journal, ahead: null }
  const applied = d.query(
    `SELECT hash, created_at, version FROM ${MIGRATIONS_TABLE} ORDER BY created_at`,
  ).all() as { hash: string; created_at: number; version: string | null }[]
  const expected = new Map(journal.map((entry) => [entry.when, createHash('sha256').update(
    readFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), 'utf8'),
  ).digest('hex')]))
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

function baselineTableNames(): string[] {
  const migration = readFileSync(join(MIGRATIONS_FOLDER, `${migrationJournal()[0]!.tag}.sql`), 'utf8')
  return [...migration.matchAll(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?[`"[]?([A-Za-z_][A-Za-z0-9_]*)/gi)]
    .map((match) => match[1]!).filter((name) => name !== MIGRATIONS_TABLE).sort()
}

function tableDiff(d: Database): string {
  const expected = baselineTableNames()
  const actual = (d.query(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>? ORDER BY name",
  ).all(MIGRATIONS_TABLE) as { name: string }[]).map((row) => row.name)
  const missing = expected.filter((name) => !actual.includes(name))
  const unexpected = actual.filter((name) => !expected.includes(name))
  return [`missing tables: ${missing.join(', ') || 'none'}`, `unexpected tables: ${unexpected.join(', ') || 'none'}`].join('\n')
}

export function canonicalSchemaHash(d: Database): string | null {
  try {
    return (d.query("SELECT value FROM schema_meta WHERE key='schema'").get() as
      { value: string } | null)?.value ?? null
  } catch { return null }
}

export const BASELINE_SCHEMA_HASH = 'e5d0fa17fb7fb3087e4fda38a8cb31be0793fb4b68849ef1ae6eb08a127a9292'

function ensureMigrationsTable(d: Database): void {
  d.exec(`CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hash TEXT NOT NULL,
    created_at NUMERIC,
    version TEXT
  )`)
}

function adoptBaseline(d: Database): string[] | null {
  if (tableExists(d, MIGRATIONS_TABLE)) return null
  const applicationTables = (d.query(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
  ).get() as { n: number }).n
  if (applicationTables === 0) return null
  if (canonicalSchemaHash(d) !== BASELINE_SCHEMA_HASH || tableDiff(d).includes('missing tables: none') === false ||
      tableDiff(d).includes('unexpected tables: none') === false) {
    throw new Error(
      `refusing to adopt migration baseline: the existing store does not match it\n${tableDiff(d)}\n` +
      `back up the store and run the old binary's open once`,
    )
  }
  const entry = migrationJournal()[0]!
  const source = readFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), 'utf8')
  ensureMigrationsTable(d)
  d.exec('BEGIN IMMEDIATE')
  try {
    d.query(`INSERT INTO ${MIGRATIONS_TABLE} (hash,created_at,version) VALUES (?,?,?)`)
      .run(createHash('sha256').update(source).digest('hex'), entry.when, entry.tag)
    d.exec('COMMIT')
  } catch (error) {
    d.exec('ROLLBACK')
    throw error
  }
  return [entry.tag]
}

/** Apply each journal entry through Drizzle's bun:sqlite migrator in its own IMMEDIATE transaction. */
export function applyMigrations(d: Database): string[] {
  const adopted = adoptBaseline(d)
  if (adopted) return adopted
  const state = migrationState(d)
  if (state.ahead) {
    throw new Error(`refusing to migrate a store ahead of this binary's migration journal: ${state.ahead}`)
  }
  ensureMigrationsTable(d)
  const before = new Set((d.query(`SELECT created_at FROM ${MIGRATIONS_TABLE}`).all() as
    { created_at: number }[]).map((row) => Number(row.created_at)))
  const database = drizzle(d)
  const dialect = (database as any).dialect
  const session = (database as any).session
  const dialectMigrate = dialect.migrate.bind(dialect)
  const sessionRun = session.run.bind(session)
  session.run = (query: any) => {
    const rendered = dialect.sqlToQuery(query).sql.trim().toUpperCase()
    return sessionRun(rendered === 'BEGIN' ? sql.raw('BEGIN IMMEDIATE') : query)
  }
  dialect.migrate = (migrations: MigrationMeta[], currentSession: unknown, config: unknown) => {
    for (const migration of migrations) dialectMigrate([migration], currentSession, config)
  }
  try {
    migrate(database, { migrationsFolder: MIGRATIONS_FOLDER, migrationsTable: MIGRATIONS_TABLE })
  } finally {
    dialect.migrate = dialectMigrate
    session.run = sessionRun
  }
  const journal = migrationJournal()
  for (const entry of journal) {
    d.query(`UPDATE ${MIGRATIONS_TABLE} SET version=? WHERE created_at=? AND version IS NULL`)
      .run(entry.tag, entry.when)
  }
  return journal.filter((entry) => !before.has(entry.when)).map((entry) => entry.tag)
}
