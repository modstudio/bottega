import '../hub/test/preload.ts'
import { beforeEach, expect, test } from 'bun:test'
import { writeTransaction } from '../hub/src/db.ts'
import { resetFixtureStore } from '../hub/test/run-fixtures.ts'
import { taskReader } from '../orchestrator/src/workflow/task-read-port.ts'
import { installCliTaskReader } from './task-read-adapter.ts'

beforeEach(resetFixtureStore)

test('installing the CLI adapter leaves hub unloaded until the first read', () => {
  const hubTaskModule = require.resolve('../hub/src/task.ts')
  const hubTaskDocumentModule = require.resolve('../hub/src/task-document.ts')
  expect(require.cache[hubTaskModule]).toBeUndefined()
  expect(require.cache[hubTaskDocumentModule]).toBeUndefined()

  installCliTaskReader()

  expect(require.cache[hubTaskModule]).toBeUndefined()
  expect(require.cache[hubTaskDocumentModule]).toBeUndefined()

  const recordId = Bun.randomUUIDv7()
  const stamp = new Date().toISOString()
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
