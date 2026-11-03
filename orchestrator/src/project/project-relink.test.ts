import { Database } from 'bun:sqlite'
import { afterEach, expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import {
  installRecordSessionRunner,
  memoryRecordSession,
} from '../../test/fixtures/record-session.ts'
import { db } from '../database/db.ts'
import { completeSignInCommand } from '../record/record-auth-command.ts'
import { PROJECT_REFERENCES } from './project-reference-counts.ts'
import {
  adoptHostedProjectIdentity,
  relinkProjectByName,
  relinkProjectIdentity,
} from './project-relink.ts'
import { projectByName, upsertProject } from './projects.ts'

function relinkDatabase(): Database {
  const database = new Database(':memory:')
  database.exec('PRAGMA foreign_keys = ON')
  database.exec(
    `CREATE TABLE project (record_id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL);
     CREATE TABLE outbox (
       id INTEGER PRIMARY KEY, kind TEXT NOT NULL, row_id TEXT NOT NULL, payload TEXT NOT NULL,
       created_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
       synced_at TEXT, quarantined_at TEXT, quarantine_reason TEXT, retired_at TEXT,
       retirement_reason TEXT, record_id TEXT NOT NULL
     );
     CREATE TABLE outbox_quarantine_audit (
       id INTEGER PRIMARY KEY, outbox_id INTEGER NOT NULL, kind TEXT NOT NULL, row_id TEXT NOT NULL,
       error TEXT, attempts INTEGER NOT NULL, disposition TEXT NOT NULL, actor_session TEXT,
       at TEXT NOT NULL, reason TEXT, record_id TEXT NOT NULL
     );`,
  )
  const columns = new Map<string, Set<string>>()
  for (const [key, , column, explicitTable] of PROJECT_REFERENCES) {
    const table = explicitTable ?? key
    const tableColumns = columns.get(table) ?? new Set<string>()
    tableColumns.add(column)
    columns.set(table, tableColumns)
  }
  for (const [table, tableColumns] of columns) {
    database.exec(
      `CREATE TABLE ${table} (${[...tableColumns]
        .map((column) => `${column} TEXT REFERENCES project(record_id) DEFERRABLE INITIALLY DEFERRED`)
        .join(',')})`,
    )
  }
  return database
}

function insertReferenceRows(database: Database, projectId: string, otherId: string): void {
  const columns = new Map<string, Set<string>>()
  for (const [key, , column, explicitTable] of PROJECT_REFERENCES) {
    const table = explicitTable ?? key
    const tableColumns = columns.get(table) ?? new Set<string>()
    tableColumns.add(column)
    columns.set(table, tableColumns)
  }
  for (const [table, tableColumns] of columns) {
    const names = [...tableColumns]
    const placeholders = names.map(() => '?').join(',')
    database
      .query(`INSERT INTO ${table} (${names.join(',')}) VALUES (${placeholders})`)
      .run(...names.map(() => projectId))
    database
      .query(`INSERT INTO ${table} (${names.join(',')}) VALUES (${placeholders})`)
      .run(...names.map(() => otherId))
  }
}

afterEach(() => {
  installRecordApiClient(null)
})

test('relink rewrites every registered reference and only pending matching payload identities', () => {
  const database = relinkDatabase()
  const oldId = newRecordId()
  const hostedId = newRecordId()
  const otherId = newRecordId()
  database.query('INSERT INTO project VALUES (?,?)').run(oldId, 'local')
  database.query('INSERT INTO project VALUES (?,?)').run(otherId, 'other')
  insertReferenceRows(database, oldId, otherId)
  const pending = JSON.stringify({ projectId: oldId, nested: { sourceProjectId: oldId } })
  const other = JSON.stringify({ projectId: otherId })
  for (const [id, payload, syncedAt] of [
    [1, pending, null],
    [2, other, null],
    [3, pending, '2026-01-01T00:00:00.000Z'],
  ] as const) {
    database
      .query(
        `INSERT INTO outbox
         (id,kind,row_id,payload,created_at,synced_at,record_id)
         VALUES (?,'run',?,?,'2026-01-01T00:00:00.000Z',?,?)`,
      )
      .run(id, String(id), payload, syncedAt, newRecordId())
  }
  database
    .query(
      `INSERT INTO outbox
       (id,kind,row_id,payload,created_at,quarantined_at,quarantine_reason,last_error,record_id)
       VALUES (4,'run','4',?,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',?,?,?)`,
    )
    .run(
      pending,
      `record project ${oldId} is absent from request space space-a`,
      `record project ${oldId} is absent from request space space-a`,
      newRecordId(),
    )

  const result = relinkProjectIdentity({ name: 'local', recordId: oldId }, hostedId, database)

  expect(result).toMatchObject({ oldId, newId: hostedId, status: 'relinked' })
  for (const [key, , column, explicitTable] of PROJECT_REFERENCES) {
    const table = explicitTable ?? key
    expect(
      database.query(`SELECT ${column} value FROM ${table} ORDER BY rowid`).all(),
      `${table}.${column}`,
    ).toEqual([{ value: hostedId }, { value: otherId }])
  }
  expect(database.query('SELECT record_id FROM project WHERE name=?').get('local')).toEqual({
    record_id: hostedId,
  })
  const payloads = database.query<{ payload: string }, []>('SELECT payload FROM outbox ORDER BY id').all()
  expect(JSON.parse(payloads[0]!.payload)).toEqual({
    projectId: hostedId,
    nested: { sourceProjectId: hostedId },
  })
  expect(payloads[1]!.payload).toBe(other)
  expect(payloads[2]!.payload).toBe(pending)
  expect(JSON.parse(payloads[3]!.payload).projectId).toBe(hostedId)
  expect(
    database.query('SELECT quarantined_at,quarantine_reason FROM outbox WHERE id=4').get(),
  ).toEqual({ quarantined_at: null, quarantine_reason: null })
  expect(result.retried).toBe(1)
})

test('a project without a hosted namesake is unchanged', async () => {
  const localId = newRecordId()
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    listProjects: async () => [],
  })
  const database = relinkDatabase()
  database.query('INSERT INTO project VALUES (?,?)').run(localId, 'no-namesake')
  const result = await adoptHostedProjectIdentity(
    {
      recordId: localId,
      name: 'no-namesake',
      path: '/tmp/no-namesake',
      stack: null,
      canon: true,
      retiredAt: null,
      settings: {},
    },
    database,
  )
  expect(result).toEqual({ name: 'no-namesake', status: 'no-namesake' })
  expect(database.query('SELECT record_id FROM project').get()).toEqual({ record_id: localId })
})

test('project relink refuses a retired hosted namesake', async () => {
  const name = `retired-relink-${newRecordId()}`
  upsertProject({ recordId: newRecordId(), name, path: `/tmp/${name}` })
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    listProjects: async () => [
      {
        id: newRecordId(),
        name,
        spaceId: 'space-a',
        spaceName: 'Space A',
        keyPrefixes: [],
        stack: null,
        managedContext: false,
        landingBranch: null,
        color: null,
        colorDark: null,
        canon: true,
        settings: {},
        retiredAt: '2026-01-01T00:00:00.000Z',
      },
    ],
  })
  await expect(relinkProjectByName(name)).rejects.toThrow(
    `hosted project ${name} is retired in the space`,
  )
})

test('record sign-in adopts a local project with a hosted namesake', async () => {
  const name = `sign-in-relink-${newRecordId()}`
  const oldId = newRecordId()
  const hostedId = newRecordId()
  upsertProject({ recordId: oldId, name, path: `/tmp/${name}` })
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    listProjects: async () => [
      {
        id: hostedId,
        name,
        spaceId: 'space-a',
        spaceName: 'Space A',
        keyPrefixes: [],
        stack: null,
        managedContext: false,
        landingBranch: null,
        color: null,
        colorDark: null,
        canon: true,
        settings: {},
        retiredAt: null,
      },
    ],
  })
  const session = memoryRecordSession()
  installRecordSessionRunner(session.runner)
  const output: string[] = []
  try {
    await completeSignInCommand(
      { token: 'token', user: { id: 'user-a', email: 'a@example.test' } },
      { log: (line) => output.push(line) },
    )
  } finally {
    installRecordSessionRunner(null)
  }
  expect(projectByName(name)?.recordId).toBe(hostedId)
  expect(output).toContain(`signed in a@example.test`)
  expect(output.some((line) => line.includes(`${oldId} -> ${hostedId}`))).toBe(true)
})
