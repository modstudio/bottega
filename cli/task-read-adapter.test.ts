import '../hub/test/preload.ts'
import { Database } from 'bun:sqlite'
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { projectRegisterReader } from '../hub/src/project-register-reader.ts'
import { resetFixtureStore } from '../hub/test/run-fixtures.ts'
import { DB_PATH, db } from '../orchestrator/src/database/db.ts'
import { applyMigrations } from '../orchestrator/src/database/migrations.ts'
import { registerStandardRuntime } from '../orchestrator/src/runtime/runtime-registration.ts'
import { taskReader } from '../orchestrator/src/workflow/task-read-port.ts'
import { addProject } from '../orchestrator/test/fixtures/offline-branch-landing.ts'
import { OrchProjectListSchema } from '../shared/orch-contract.ts'
import { installCliTaskReader } from './task-read-adapter.ts'

let projectRecordId: string

beforeAll(() => {
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
})

test('installing the CLI adapter leaves hub unloaded until the first read', () => {
  const hubTaskModule = require.resolve('../hub/src/task.ts')
  const hubTaskDocumentModule = require.resolve('../hub/src/task-document.ts')
  const hubDatabaseModule = require.resolve('../hub/src/db.ts')
  delete require.cache[hubTaskModule]
  delete require.cache[hubTaskDocumentModule]
  delete require.cache[hubDatabaseModule]
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

  expect(taskReader().list()).toContainEqual(
    expect.objectContaining({ record_id: recordId, key: 'ALP-2451', project: 'alpha' }),
  )
  expect(taskReader().duplicates('alpha', 'In-process reads')).toContainEqual(
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
