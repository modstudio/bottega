import '../hub/test/preload.ts'
import { Database } from 'bun:sqlite'
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { applyMigrations as applyHubMigrations } from '../hub/src/migrations.ts'
import { projectRegisterReader } from '../hub/src/project-register-reader.ts'
import { HUB_MIGRATION_BACKFILL_VALUES } from '../hub/test/migration-values.ts'
import { resetFixtureStore } from '../hub/test/run-fixtures.ts'
import {
  closeDatabaseForFixture as closeOrchestratorDatabaseForFixture,
  DB_PATH,
  db,
  registerOpenHooks,
} from '../orchestrator/src/database/db.ts'
import { applyMigrations } from '../orchestrator/src/database/migrations.ts'
import { registerStandardRuntime } from '../orchestrator/src/runtime/runtime-registration.ts'
import { taskReader } from '../orchestrator/src/workflow/task-read-port.ts'
import { addProject } from '../orchestrator/test/fixtures/offline-branch-landing.ts'
import { FROZEN_STATE_NAMES } from '../shared/brand.ts'
import { OrchProjectListSchema } from '../shared/orch-contract.ts'
import { captureTestHubDatabase, mintTestHubDatabase } from '../shared/test-hub-database.ts'
import { installCliProjectRegisterReader, installCliTaskReader } from './task-read-adapter.ts'

const lazyHubTaskModules = [
  require.resolve('../hub/src/task.ts'),
  require.resolve('../hub/src/task-document.ts'),
  require.resolve('../hub/src/db.ts'),
  require.resolve('../hub/src/task-local-read.ts'),
]

let adapterHubDatabaseDirectory: string | undefined
let projectRecordId: string
let restoreHubDatabase: (() => void) | undefined
let previousHostedUrl: string | undefined

beforeAll(() => {
  restoreHubDatabase = captureTestHubDatabase()
  const adapterStore = mintTestHubDatabase(FROZEN_STATE_NAMES.hubDatabase)
  adapterHubDatabaseDirectory = adapterStore.directory
  const adapterDatabase = new Database(adapterStore.database, { create: true })
  adapterDatabase.exec('PRAGMA foreign_keys = ON;')
  applyHubMigrations(adapterDatabase, undefined, HUB_MIGRATION_BACKFILL_VALUES)
  adapterDatabase.close()
  previousHostedUrl = process.env.BOTTEGA_HOSTED_URL
  delete process.env.BOTTEGA_HOSTED_URL
  registerStandardRuntime()
  const database = new Database(DB_PATH, { create: true })
  try {
    database.exec('PRAGMA foreign_keys = ON;')
    applyMigrations(database)
  } finally {
    database.close()
  }
})

beforeEach(() => {
  resetFixtureStore()
  db().query("DELETE FROM project WHERE name = 'alpha'").run()
  projectRecordId = addProject('alpha', '/fixtures/repos/alpha')
})

afterAll(() => {
  db().query("DELETE FROM project WHERE name = 'alpha'").run()
  const { closeDatabaseForFixture } =
    require('../hub/src/db.ts') as typeof import('../hub/src/db.ts')
  closeDatabaseForFixture()
  restoreHubDatabase?.()
  for (const module of lazyHubTaskModules) delete require.cache[module]
  if (adapterHubDatabaseDirectory)
    rmSync(adapterHubDatabaseDirectory, { recursive: true, force: true })
  if (previousHostedUrl === undefined) delete process.env.BOTTEGA_HOSTED_URL
  else process.env.BOTTEGA_HOSTED_URL = previousHostedUrl
})

test('installing the CLI adapter leaves hub unloaded until the first read', async () => {
  for (const module of lazyHubTaskModules) delete require.cache[module]
  for (const module of lazyHubTaskModules) expect(require.cache[module]).toBeUndefined()

  installCliTaskReader()

  for (const module of lazyHubTaskModules) expect(require.cache[module]).toBeUndefined()

  const recordId = Bun.randomUUIDv7()
  const stamp = new Date().toISOString()
  const { writeTransaction } = require('../hub/src/db.ts') as typeof import('../hub/src/db.ts')
  writeTransaction((database) =>
    database
      .query(
        `INSERT INTO task
         (record_id,key,project,title,status,status_category,source,first_seen,last_seen)
         VALUES (?, 'ALP-2451', 'alpha', 'In-process reads', 'active', 'active', 'local', ?, ?)`,
      )
      .run(recordId, stamp, stamp),
  )

  expect(await taskReader().list()).toContainEqual(
    expect.objectContaining({ record_id: recordId, key: 'ALP-2451', project: 'alpha' }),
  )
  expect(await taskReader().listLocal({ project: 'alpha' })).toContainEqual(
    expect.objectContaining({ record_id: recordId, key: 'ALP-2451', project: 'alpha' }),
  )
  expect(await taskReader().duplicates('alpha', 'In-process reads')).toContainEqual(
    expect.objectContaining({ key: 'ALP-2451', title: 'In-process reads' }),
  )
  for (const module of lazyHubTaskModules) expect(require.cache[module]).toBeDefined()
})

test('the standalone register reader returns schema-valid registered projects', () => {
  installCliProjectRegisterReader()

  const rows = projectRegisterReader()?.()

  expect(OrchProjectListSchema.parse(rows)).toContainEqual(
    expect.objectContaining({
      record_id: projectRecordId,
      name: 'alpha',
    }),
  )
})

test('the standalone register reader does not require writable store hooks', () => {
  closeOrchestratorDatabaseForFixture()
  const restoreHooks = registerOpenHooks({})
  try {
    installCliProjectRegisterReader()

    expect(projectRegisterReader()?.()).toContainEqual(
      expect.objectContaining({ record_id: projectRecordId, name: 'alpha' }),
    )
  } finally {
    closeOrchestratorDatabaseForFixture()
    restoreHooks()
  }
})
