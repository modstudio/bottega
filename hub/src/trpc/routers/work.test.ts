import { beforeAll, beforeEach, expect, test } from 'bun:test'
import { resetFixtureStore } from '../../../test/run-fixtures.ts'
import { db, writeTransaction } from '../../db.ts'
import { taskBodyVersion } from '../../task-detail.ts'
import { createWorkRouter } from './work.ts'

beforeAll(resetFixtureStore)
beforeEach(resetFixtureStore)

test('task reads disable edits when machine identity resolution throws', async () => {
  const router = createWorkRouter({
    strip: (() => ({})) as never,
    view: (async () => ({})) as never,
    machineAttribution: (async () => {
      throw new Error('identity offline')
    }) as never,
    taskRecord: ((_key: string, _scope: unknown, readerUserId: string | null) => ({
      task: { key: 'DEV-1' },
      comments: [
        { id: 'comment-1', canEdit: readerUserId !== null, canDelete: readerUserId !== null },
      ],
      documents: [],
      statusEvents: [],
      runs: [],
    })) as never,
  })
  const result = await router.createCaller({}).task({ key: 'DEV-1', scope: {} })
  expect(result.comments[0]).toMatchObject({ canEdit: false, canDelete: false })
})

test('setBody maps the service stale-body error to CONFLICT and leaves the body unchanged', async () => {
  const recordId = Bun.randomUUIDv7()
  const stamp = new Date().toISOString()
  writeTransaction((conn) =>
    conn
      .query(
        `INSERT INTO task
         (record_id,key,project,title,status,status_category,body,source,first_seen,last_seen)
         VALUES (?, 'DEV-1', 'workshop', 'Task', 'open', 'open', 'current', 'local', ?, ?)`,
      )
      .run(recordId, stamp, stamp),
  )
  const router = createWorkRouter({
    strip: (() => ({})) as never,
    view: (async () => ({})) as never,
  })
  const caller = router.createCaller({})
  await caller.setBody({
    key: 'DEV-1',
    scope: { recordId },
    body: 'saved',
    expectedVersion: taskBodyVersion('current'),
  })
  await expect(
    caller.setBody({
      key: 'DEV-1',
      scope: { recordId },
      body: 'stale',
      expectedVersion: taskBodyVersion('current'),
    }),
  ).rejects.toMatchObject({ code: 'CONFLICT' })
  expect(
    db().query<{ body: string }, [string]>('SELECT body FROM task WHERE record_id=?').get(recordId),
  ).toEqual({ body: 'saved' })
})
