import type { Database } from 'bun:sqlite'
import { afterEach, expect, test } from 'bun:test'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { fillProjectRecordIds } from '../project/project-record-identity.ts'
import {
  applyMigrations,
  applyMigrationsBefore,
  migrationApplied,
  readUserVersion,
} from './migrations.ts'
import { migratedTestDatabase, migrationBoundaryTestDatabase } from './test-database.fixture.ts'

const CONTRACT = '0115_project_identity_contract'
const priorRecordApiUrl = process.env.ORCH_RECORD_API_URL

afterEach(() => {
  installRecordApiClient(null)
  if (priorRecordApiUrl === undefined) delete process.env.ORCH_RECORD_API_URL
  else process.env.ORCH_RECORD_API_URL = priorRecordApiUrl
})

function preContractProject(database: Database, recordId: string | null): void {
  database
    .query('INSERT INTO project (record_id,name,path,settings) VALUES (?, ?, ?, ?)')
    .run(recordId, 'fixture', '/fixture', '{}')
}

test('the real two-phase migrate mints locally before contracting without hosting', async () => {
  delete process.env.ORCH_RECORD_API_URL
  const database = migrationBoundaryTestDatabase(CONTRACT)
  try {
    preContractProject(database, null)
    const beforeContract = readUserVersion(database)

    const filled = await fillProjectRecordIds(database)
    expect(filled).toHaveLength(1)
    expect(filled[0]?.source).toBe('local')
    expect(readUserVersion(database)).toBe(beforeContract)

    applyMigrations(database)
    expect(migrationApplied(database, CONTRACT)).toBe(true)
    expect(database.query('SELECT record_id FROM project').get()).toEqual({
      record_id: filled[0]!.recordId,
    })
    expect(
      database
        .query(
          "SELECT \"notnull\" required FROM pragma_table_info('project') WHERE name='record_id'",
        )
        .get(),
    ).toEqual({ required: 1 })
  } finally {
    database.close()
  }
})

test('the real two-phase migrate skips authority and network when no identity is missing', async () => {
  delete process.env.ORCH_RECORD_API_URL
  const database = migrationBoundaryTestDatabase(CONTRACT)
  try {
    preContractProject(database, '01990000-0000-7000-8000-000000001214')
    database.exec(
      "INSERT INTO record_install_binding (id,bound_at) VALUES (1,'2026-10-15T00:00:00.000Z')",
    )
    installRecordApiClient({
      ...createMemoryRecordApiClient(),
      whoami: async () => {
        throw new Error('network must not be touched')
      },
    })

    expect(await fillProjectRecordIds(database)).toEqual([])
    applyMigrations(database)
    expect(migrationApplied(database, CONTRACT)).toBe(true)
  } finally {
    database.close()
  }
})

test('the real two-phase migrate refuses unreachable hosting before contraction', async () => {
  process.env.ORCH_RECORD_API_URL = 'https://record-api.example.test'
  const database = migrationBoundaryTestDatabase(CONTRACT)
  try {
    preContractProject(database, null)
    const beforeContract = readUserVersion(database)
    installRecordApiClient({
      ...createMemoryRecordApiClient(),
      whoami: async () => {
        throw new Error('record API is unreachable: fixture offline')
      },
    })

    await expect(fillProjectRecordIds(database)).rejects.toThrow('record API is unreachable')
    expect(migrationApplied(database, CONTRACT)).toBe(false)
    expect(readUserVersion(database)).toBe(beforeContract)
    expect(database.query('SELECT record_id FROM project').get()).toEqual({ record_id: null })
  } finally {
    database.close()
  }
})

test('a bounded phase never lowers a fully current store when the next step throws', () => {
  const database = migratedTestDatabase()
  try {
    applyMigrations(database)
    const current = readUserVersion(database)
    expect(() => {
      applyMigrationsBefore(database, CONTRACT)
      throw new Error('between-phase fill failed')
    }).toThrow('between-phase fill failed')
    expect(readUserVersion(database)).toBe(current)
  } finally {
    database.close()
  }
})
