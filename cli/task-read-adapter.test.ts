import '../hub/test/preload.ts'
import { Database } from 'bun:sqlite'
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { applyMigrations as applyHubMigrations } from '../hub/src/migrations.ts'
import { projectRegisterReader } from '../hub/src/project-register-reader.ts'
import { HUB_MIGRATION_BACKFILL_VALUES } from '../hub/test/migration-values.ts'
import { resetFixtureStore } from '../hub/test/run-fixtures.ts'
import { DB_PATH, db } from '../orchestrator/src/database/db.ts'
import { applyMigrations } from '../orchestrator/src/database/migrations.ts'
import { registerStandardRuntime } from '../orchestrator/src/runtime/runtime-registration.ts'
import { taskReader } from '../orchestrator/src/workflow/task-read-port.ts'
import { addProject } from '../orchestrator/test/fixtures/offline-branch-landing.ts'
import { FROZEN_STATE_NAMES } from '../shared/brand.ts'
import { OrchProjectListSchema } from '../shared/orch-contract.ts'
import { captureTestHubDatabase, mintTestHubDatabase } from '../shared/test-hub-database.ts'
import { installCliTaskReader } from './task-read-adapter.ts'

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
  const hubDatabaseModule = require.resolve('../hub/src/db.ts')
  const { closeDatabaseForFixture } =
    require('../hub/src/db.ts') as typeof import('../hub/src/db.ts')
  closeDatabaseForFixture()
  restoreHubDatabase?.()
  delete require.cache[require.resolve('../hub/src/task.ts')]
  delete require.cache[require.resolve('../hub/src/task-document.ts')]
  delete require.cache[hubDatabaseModule]
  delete require.cache[require.resolve('../hub/src/task-local-read.ts')]
  if (adapterHubDatabaseDirectory)
    rmSync(adapterHubDatabaseDirectory, { recursive: true, force: true })
  if (previousHostedUrl === undefined) delete process.env.BOTTEGA_HOSTED_URL
  else process.env.BOTTEGA_HOSTED_URL = previousHostedUrl
})

test('installing the CLI adapter leaves hub unloaded until the first read', async () => {
  const hubTaskModule = require.resolve('../hub/src/task.ts')
  const hubTaskDocumentModule = require.resolve('../hub/src/task-document.ts')
  const hubDatabaseModule = require.resolve('../hub/src/db.ts')
  const hubTaskLocalReadModule = require.resolve('../hub/src/task-local-read.ts')
  delete require.cache[hubTaskModule]
  delete require.cache[hubTaskDocumentModule]
  delete require.cache[hubDatabaseModule]
  delete require.cache[hubTaskLocalReadModule]
  expect(require.cache[hubTaskModule]).toBeUndefined()
  expect(require.cache[hubTaskDocumentModule]).toBeUndefined()

  installCliTaskReader()

  expect(require.cache[hubTaskModule]).toBeUndefined()
  expect(require.cache[hubTaskDocumentModule]).toBeUndefined()

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
  expect(await taskReader().duplicates('alpha', 'In-process reads')).toContainEqual(
    expect.objectContaining({ key: 'ALP-2451', title: 'In-process reads' }),
  )
  expect(require.cache[hubTaskModule]).toBeDefined()
  expect(require.cache[hubTaskDocumentModule]).toBeDefined()
})

test('the installed register reader returns schema-valid registered projects', () => {
  installCliTaskReader()

  const rows = projectRegisterReader()?.()

  expect(OrchProjectListSchema.parse(rows)).toContainEqual(
    expect.objectContaining({
      record_id: projectRecordId,
      name: 'alpha',
    }),
  )
})
