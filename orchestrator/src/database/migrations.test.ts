import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PLATFORM_NAME } from '../../../shared/brand.ts'
import { registerEmbeddedAssets } from '../../../shared/embedded-assets.ts'
import {
  applyMigrations,
  applyMigrationsBefore,
  canonicalSchemaHash,
  expectedSchemaHash,
  MIGRATIONS_FOLDER,
  migrationJournal,
  splitMigrationSource,
  stripSqlComments,
} from './migrations.ts'
import { migratedTestDatabase, migrationBoundaryTestDatabase } from './test-database.fixture.ts'
import { WRITE_PROBE_TABLE_PREFIX } from './write-probe.ts'

function applyOneMigration(database: import('bun:sqlite').Database, tag: string): string[] {
  const journal = migrationJournal()
  const index = journal.findIndex((entry) => entry.tag === tag)
  const next = journal[index + 1]
  return next ? applyMigrationsBefore(database, next.tag) : applyMigrations(database)
}

function additiveStatementRefusal(statement: string): string | null {
  const normalized = stripSqlComments(statement).trim().replace(/\s+/g, ' ')
  if (!normalized) return null
  if (/^CREATE\s+TABLE\b/i.test(normalized)) return null
  if (/^CREATE\s+(?:UNIQUE\s+)?INDEX\b/i.test(normalized)) return null
  if (/^CREATE\s+TRIGGER\b/i.test(normalized)) return null
  if (/^END$/i.test(normalized)) return null
  if (/^ALTER\s+TABLE\b[\s\S]*\bADD(?:\s+COLUMN)?\b/i.test(normalized)) {
    if (!/\bNOT\s+NULL\b/i.test(normalized) || /\bDEFAULT\b/i.test(normalized)) return null
  }
  return normalized
}

function sqlStatements(source: string): string[] {
  const statements: string[] = []
  let start = 0
  let inString = false
  for (let index = 0; index < source.length; index++) {
    if (source[index] === "'") {
      if (inString && source[index + 1] === "'") index++
      else inString = !inString
    } else if (source[index] === ';' && !inString) {
      statements.push(source.slice(start, index))
      start = index + 1
    }
  }
  statements.push(source.slice(start))
  return statements
}

test('every additive journal marker describes purely additive SQL', () => {
  for (const entry of migrationJournal()) {
    if (entry.compatibility !== 'additive') continue
    const ddl = splitMigrationSource(
      readFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), 'utf8'),
    ).ddl
    for (const statement of sqlStatements(ddl)) {
      const offending = additiveStatementRefusal(statement)
      if (offending)
        throw new Error(`additive migration ${entry.tag} has non-additive SQL: ${offending}`)
    }
  }
})

test('embedded migrations produce the disk journal and schema hash', () => {
  const diskJournal = migrationJournal()
  const diskHash = expectedSchemaHash()
  const assets: Record<string, string> = {
    'orchestrator/migrations/meta/_journal.json': readFileSync(
      join(MIGRATIONS_FOLDER, 'meta', '_journal.json'),
      'utf8',
    ),
  }
  for (const entry of diskJournal) {
    assets[`orchestrator/migrations/${entry.tag}.sql`] = readFileSync(
      join(MIGRATIONS_FOLDER, `${entry.tag}.sql`),
      'utf8',
    )
  }
  registerEmbeddedAssets({
    assets,
    files: {},
    manifest: {
      name: PLATFORM_NAME,
      version: '1.2.3',
      built: '2026-09-18T12:34:56.000Z',
      commit: 'abcdef1234567890',
    },
  })
  try {
    expect(migrationJournal()).toEqual(diskJournal)
    expect(expectedSchemaHash()).toBe(diskHash)
  } finally {
    registerEmbeddedAssets(null)
  }
})

test('the schema hash ignores an in-flight write probe table', () => {
  const database = migratedTestDatabase()
  try {
    const before = expectedSchemaHash()
    database.exec(`CREATE TABLE "${WRITE_PROBE_TABLE_PREFIX}12345" (value INTEGER)`)
    expect(canonicalSchemaHash(database)).toBe(before)
  } finally {
    database.close()
  }
})

test('the schema hash includes a malformed write-probe table name', () => {
  const database = migratedTestDatabase()
  try {
    const before = expectedSchemaHash()
    database.exec(`CREATE TABLE "${WRITE_PROBE_TABLE_PREFIX}not_a_pid" (value INTEGER)`)
    expect(canonicalSchemaHash(database)).not.toBe(before)
  } finally {
    database.close()
  }
})

test('a fresh database seeds discoverable agents without machine probe claims', () => {
  const database = migratedTestDatabase()
  try {
    const rows = database
      .query(
        'SELECT name, caps, billing, operated_by, probed_at, probe_result FROM agent ORDER BY name',
      )
      .all() as {
      name: string
      caps: string
      billing: string
      operated_by: string
      probed_at: string | null
      probe_result: string | null
    }[]

    expect(rows.map((row) => row.name)).toEqual(['agy', 'codex', 'grok', 'qwen-local'])
    expect(rows.every((row) => row.probed_at === null && row.probe_result === null)).toBe(true)
    expect(rows.every((row) => Object.hasOwn(JSON.parse(row.caps), 'readsRepo'))).toBe(true)
    expect(
      rows.map(({ name, billing, operated_by }) => ({
        name,
        billing,
        operated_by,
      })),
    ).toEqual([
      { name: 'agy', billing: 'free', operated_by: 'vendor' },
      { name: 'codex', billing: 'subscription', operated_by: 'vendor' },
      { name: 'grok', billing: 'subscription', operated_by: 'vendor' },
      { name: 'qwen-local', billing: 'none', operated_by: 'self' },
    ])
    expect(
      database
        .query(
          `SELECT name,"notnull" AS required FROM pragma_table_info('release_ledger') WHERE name='actor'`,
        )
        .get(),
    ).toEqual({ name: 'actor', required: 1 })
  } finally {
    database.close()
  }
})

test('board purpose migration backfills existing questions as requests and notices as information', () => {
  const database = migrationBoundaryTestDatabase('0103_board_message_purpose')
  try {
    const insert = database.query(
      `INSERT INTO board_message
       (kind,author_kind,audience,title,body,ack_required,expires_at,created_at)
       VALUES (?, 'operator', 'operator', ?, 'Body', 0, '2026-10-14', '2026-10-13')`,
    )
    insert.run('notice', 'Notice')
    insert.run('question', 'Question')
    expect(applyOneMigration(database, '0103_board_message_purpose')).toEqual([
      '0103_board_message_purpose',
    ])
    expect(database.query('SELECT kind,purpose FROM board_message ORDER BY rowid').all()).toEqual([
      { kind: 'notice', purpose: 'information' },
      { kind: 'question', purpose: 'request' },
    ])
  } finally {
    database.close()
  }
})

test('document identity migration backfills UUIDs and makes record_id required and fully unique', () => {
  const database = migrationBoundaryTestDatabase('0090_doc_record_identity_and_subject')
  try {
    database
      .query(
        `INSERT INTO doc
         (scope,subject,slug,title,body,delivery,created_at,updated_at,record_id)
         VALUES ('global',NULL,'identity','Identity','Body','demand','2026-10-08','2026-10-08',NULL)`,
      )
      .run()
    expect(applyOneMigration(database, '0090_doc_record_identity_and_subject')).toEqual([
      '0090_doc_record_identity_and_subject',
    ])
    const identity = database.query<{ record_id: string }, []>('SELECT record_id FROM doc').get()!
    expect(identity.record_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    expect(
      database
        .query<{ notnull: number }, []>(
          `SELECT "notnull" FROM pragma_table_info('doc') WHERE name='record_id'`,
        )
        .get()?.notnull,
    ).toBe(1)
    expect(
      database
        .query<{ unique: number; partial: number }, []>(
          `SELECT "unique",partial FROM pragma_index_list('doc') WHERE name='doc_record_id'`,
        )
        .get(),
    ).toEqual({ unique: 1, partial: 0 })
    expect(() =>
      database
        .query(
          `INSERT INTO doc
           (scope,subject,slug,title,body,delivery,created_at,updated_at,record_id)
           VALUES ('global',NULL,'missing','Missing','Body','demand','2026-10-08','2026-10-08',NULL)`,
        )
        .run(),
    ).toThrow()
  } finally {
    database.close()
  }
})

test('document audiences migration backfills live and revision scalar audiences', () => {
  const database = migrationBoundaryTestDatabase('0093_doc_audiences')
  try {
    database
      .query(
        `INSERT INTO doc
         (scope,subject,slug,title,body,delivery,created_at,updated_at,record_id,audience)
         VALUES ('global',NULL,'audiences','Audiences','Body','demand','2026-10-09','2026-10-09',
                 '01990000-0000-7000-8000-000000000101','user')`,
      )
      .run()
    const doc = database.query<{ id: number }, []>('SELECT id FROM doc').get()!
    database
      .query(
        `INSERT INTO doc_revision
         (doc_id,scope,subject,slug,op,title,body,delivery,author,reason,at,audience)
         VALUES (?,'global',NULL,'audiences','create','Audiences','Body','demand','test','prove backfill','2026-10-09','technical')`,
      )
      .run(doc.id)
    expect(applyOneMigration(database, '0093_doc_audiences')).toEqual(['0093_doc_audiences'])
    expect(database.query('SELECT audiences FROM doc').get()).toEqual({
      audiences: '["user"]',
    })
    expect(database.query('SELECT audiences FROM doc_revision').get()).toEqual({
      audiences: '["technical"]',
    })
    expect(
      database.query("SELECT 1 FROM pragma_table_info('doc') WHERE name='audience'").get(),
    ).toBeNull()
  } finally {
    database.close()
  }
})

test('document audience vocabulary migration converts local docs and revisions without duplicates', () => {
  const database = migrationBoundaryTestDatabase('0094_doc_audience_vocabulary')
  try {
    database
      .query(
        `INSERT INTO doc
         (scope,subject,slug,title,body,delivery,audiences,created_at,updated_at,record_id)
         VALUES ('global',NULL,'audiences','Audiences','Body','demand','["technical","user","internal"]',
                 '2026-10-09','2026-10-09','01990000-0000-7000-8000-000000000101')`,
      )
      .run()
    const doc = database.query<{ id: number }, []>('SELECT id FROM doc').get()!
    database
      .query(
        `INSERT INTO doc_revision
         (doc_id,scope,subject,slug,op,title,body,delivery,audiences,author,reason,at)
         VALUES (?,'global',NULL,'audiences','create','Audiences','Body','demand',
                 '["user","technical"]','test','prove backfill','2026-10-09')`,
      )
      .run(doc.id)
    expect(applyOneMigration(database, '0094_doc_audience_vocabulary')).toEqual([
      '0094_doc_audience_vocabulary',
    ])
    expect(database.query('SELECT audiences FROM doc').get()).toEqual({
      audiences: '["technical","internal"]',
    })
    expect(database.query('SELECT audiences FROM doc_revision').get()).toEqual({
      audiences: '["internal","technical"]',
    })
  } finally {
    database.close()
  }
})
