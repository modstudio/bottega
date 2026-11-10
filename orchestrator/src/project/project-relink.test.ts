import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { CONFIG_HOME_ENV } from '../../../shared/config-directory.ts'
import { KEYSTORE_ENV } from '../../../shared/key-store.ts'
import { machineKeyId } from '../../../shared/machine-key-id.ts'
import { writeMachineKey } from '../../../shared/machine-key-store.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { RECORD_ACTIVE_SPACE_REMEDY } from '../../../shared/record-remedies.ts'
import { generateMachineKeyPair } from '../../../shared/secret-envelope.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import {
  installRecordSessionRunner,
  memoryRecordSession,
} from '../../test/fixtures/record-session.ts'
import { completeSignInCommand } from '../record/record-auth-command.ts'
import { PROJECT_REFERENCES } from './project-reference-counts.ts'
import {
  adoptHostedProjectIdentity,
  relinkProjectByName,
  relinkProjectIdentity,
} from './project-relink.ts'
import { projectByName, upsertProject } from './projects.ts'

function createProjectRecordApiClient() {
  return {
    ...createMemoryRecordApiClient(),
    whoami: async () => ({
      user: { id: 'user-a' },
      activeSpaceId: 'space-a',
      personalSpaceId: 'space-a',
      memberships: [{ space_id: 'space-a', slug: 'space-a', permission: 'write' as const }],
    }),
  }
}

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
        .map(
          (column) => `${column} TEXT REFERENCES project(record_id) DEFERRABLE INITIALLY DEFERRED`,
        )
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
  const payloads = database
    .query<{ payload: string }, []>('SELECT payload FROM outbox ORDER BY id')
    .all()
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
    ...createProjectRecordApiClient(),
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
      settings: { space: 'space-a' },
    },
    database,
  )
  expect(result).toEqual({ name: 'no-namesake', status: 'no-namesake' })
  expect(database.query('SELECT record_id FROM project').get()).toEqual({ record_id: localId })
})

test('project relink refuses a retired hosted namesake', async () => {
  const name = `retired-relink-${newRecordId()}`
  upsertProject({
    recordId: newRecordId(),
    name,
    path: `/tmp/${name}`,
    settings: { space: 'space-a' },
  })
  installRecordApiClient({
    ...createProjectRecordApiClient(),
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
        settings: { space: 'space-a' },
        retiredAt: '2026-01-01T00:00:00.000Z',
      },
    ],
  })
  await expect(relinkProjectByName(name)).rejects.toThrow(
    `hosted project ${name} is retired in the space`,
  )
})

test('an already-linked project reports already-linked even when its hosted row is retired', async () => {
  const projectId = newRecordId()
  const name = 'already-linked-retired'
  installRecordApiClient({
    ...createProjectRecordApiClient(),
    listProjects: async () => [
      {
        id: projectId,
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
        settings: { space: 'space-a' },
        retiredAt: '2026-01-01T00:00:00.000Z',
      },
    ],
  })
  const database = relinkDatabase()
  database.query('INSERT INTO project VALUES (?,?)').run(projectId, name)

  await expect(
    adoptHostedProjectIdentity(
      {
        recordId: projectId,
        name,
        path: `/tmp/${name}`,
        stack: null,
        canon: true,
        retiredAt: null,
        settings: { space: 'space-a' },
      },
      database,
    ),
  ).resolves.toMatchObject({ name, status: 'already-linked', oldId: projectId, newId: projectId })
})

test('record sign-in adopts a local project with a hosted namesake', async () => {
  const name = `sign-in-relink-${newRecordId()}`
  const oldId = newRecordId()
  const hostedId = newRecordId()
  upsertProject({
    recordId: oldId,
    name,
    path: `/tmp/${name}`,
    settings: { space: 'space-a' },
  })
  installRecordApiClient({
    ...createProjectRecordApiClient(),
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

test('record sign-in reports one adoption failure and continues to a later project', async () => {
  const failedName = `aa-sign-in-fails-${newRecordId()}`
  const name = `zz-sign-in-continues-${newRecordId()}`
  const oldId = newRecordId()
  const hostedId = newRecordId()
  upsertProject({
    recordId: newRecordId(),
    name: failedName,
    path: `/tmp/${failedName}`,
    settings: { space: 'space-a' },
  })
  upsertProject({
    recordId: oldId,
    name,
    path: `/tmp/${name}`,
    settings: { space: 'space-a' },
  })
  let listings = 0
  installRecordApiClient({
    ...createProjectRecordApiClient(),
    listProjects: async () => {
      listings += 1
      if (listings === 1) throw new Error('space listing refused')
      return [
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
      ]
    },
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
  expect(
    output.some(
      (line) =>
        line.includes('space listing refused') &&
        line.includes(`project relink ${failedName}`) &&
        line.includes('failed'),
    ),
  ).toBe(true)
  expect(output.some((line) => line.includes(`${oldId} -> ${hostedId}`))).toBe(true)
})

describe('record sign-in machine key claim failure', () => {
  let root: string
  let previousConfigHome: string | undefined
  let previousKeyStore: string | undefined
  let previousRecordUrl: string | undefined
  let previousFetch: typeof fetch

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'sign-in-machine-claim-'))
    previousConfigHome = process.env[CONFIG_HOME_ENV]
    previousKeyStore = process.env[KEYSTORE_ENV]
    previousRecordUrl = process.env.BOTTEGA_RECORD_API_URL
    previousFetch = globalThis.fetch
    const pair = await generateMachineKeyPair()
    const keyId = await machineKeyId(pair.publicKey)
    process.env[CONFIG_HOME_ENV] = root
    process.env[KEYSTORE_ENV] = 'file'
    process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
    writeMachineKey(pair)
    globalThis.fetch = (async (input) => {
      const path = new URL(String(input)).pathname
      if (path === '/v1/config/machine-keys') {
        return Response.json({
          items: [
            {
              keyId,
              publicKey: Buffer.from(pair.publicKey).toString('base64url'),
              label: 'fixture',
              createdAt: '2026-11-03T00:00:00.000Z',
              revokedAt: null,
              userId: null,
            },
          ],
        })
      }
      if (path === '/v1/whoami') {
        return Response.json({ user: { id: 'user-a' }, activeSpaceId: null })
      }
      throw new Error(`unexpected claim request ${path}`)
    }) as typeof fetch
    installRecordApiClient(createMemoryRecordApiClient())
    const session = memoryRecordSession()
    installRecordSessionRunner(session.runner)
  })

  afterEach(() => {
    installRecordSessionRunner(null)
    globalThis.fetch = previousFetch
    if (previousConfigHome === undefined) delete process.env[CONFIG_HOME_ENV]
    else process.env[CONFIG_HOME_ENV] = previousConfigHome
    if (previousKeyStore === undefined) delete process.env[KEYSTORE_ENV]
    else process.env[KEYSTORE_ENV] = previousKeyStore
    if (previousRecordUrl === undefined) delete process.env.BOTTEGA_RECORD_API_URL
    else process.env.BOTTEGA_RECORD_API_URL = previousRecordUrl
    rmSync(root, { recursive: true, force: true })
  })

  test('record sign-in reports the claim failure message once and still completes', async () => {
    const output: string[] = []
    await completeSignInCommand(
      { token: 'token', user: { id: 'user-a', email: 'a@example.test' } },
      { log: (line) => output.push(line) },
    )
    expect(output).toEqual([
      'signed in a@example.test',
      'active record space none',
      `machine key claim failed: ${RECORD_ACTIVE_SPACE_REMEDY}`,
      `automatic board adoption failed: hosted board is unused in this fixture; run ${PLATFORM_SLUG} board adopt`,
    ])
  })
})
