import '../hub/test/preload.ts'
import { beforeEach, expect, test } from 'bun:test'
import { writeTransaction } from '../hub/src/db.ts'
import { resetFixtureStore } from '../hub/test/run-fixtures.ts'
import { PLATFORM_SLUG } from '../shared/brand.ts'
import { cliTaskReadAdapter } from './task-read-adapter.ts'

beforeEach(resetFixtureStore)

test('the CLI adapter returns a task row from the hub store', async () => {
  const recordId = Bun.randomUUIDv7()
  const stamp = new Date().toISOString()
  writeTransaction((database) =>
    database
      .query(
        `INSERT INTO task
         (record_id,key,project,title,status,status_category,source,first_seen,last_seen)
         VALUES (?, 'DEV-2451', ?, 'In-process reads', 'active', 'active', 'local', ?, ?)`,
      )
      .run(recordId, PLATFORM_SLUG, stamp, stamp),
  )

  const reader = await cliTaskReadAdapter()

  expect(reader.list()).toContainEqual(
    expect.objectContaining({ record_id: recordId, key: 'DEV-2451', project: PLATFORM_SLUG }),
  )
})
