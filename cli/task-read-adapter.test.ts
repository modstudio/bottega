import '../hub/test/preload.ts'
import { beforeEach, expect, mock, test } from 'bun:test'
import { projectRegisterReader } from '../hub/src/project-register-reader.ts'
import { resetFixtureStore } from '../hub/test/run-fixtures.ts'
import { taskReader } from '../orchestrator/src/workflow/task-read-port.ts'
import { OrchProjectListSchema } from '../shared/orch-contract.ts'
import { installCliTaskReader } from './task-read-adapter.ts'

mock.module('../orchestrator/src/project/project-read.ts', () => ({
  projects: () => [
    {
      recordId: '00000000-0000-4000-8000-000000000245',
      name: 'alpha',
      path: '/fixtures/repos/alpha',
      stack: 'typescript',
      canon: true,
      retiredAt: null,
      settings: {},
    },
  ],
}))

mock.module('../orchestrator/src/project/project-list-json.ts', () => ({
  listedProjectJson: (project: {
    recordId: string
    name: string
    path: string
    stack: string | null
    canon: boolean
    settings: Record<string, unknown>
  }) => ({
    record_id: project.recordId,
    name: project.name,
    path: project.path,
    stack: project.stack,
    canon: project.canon,
    repository: true,
    settings: project.settings,
  }),
}))

beforeEach(resetFixtureStore)

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
      record_id: '00000000-0000-4000-8000-000000000245',
      name: 'alpha',
    }),
  )
})
