import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../../shared/brand.ts'
import { resetFixtureStore } from '../../../test/run-fixtures.ts'
import { db, writeTransaction } from '../../db.ts'
import { taskBodyVersion } from '../../task-detail.ts'
import { createWorkRouter } from './work.ts'

beforeAll(resetFixtureStore)
afterAll(resetFixtureStore)
beforeEach(resetFixtureStore)

const closedTask = {
  key: 'DEV-1',
  project: 'workshop',
  status: 'done',
  status_category: 'done',
} as never

test('setStatus resolves with the closed task and exact residue message', async () => {
  const { TaskClosedWithResidueError } = await import('../../task-closed-residue.ts')
  const message = `task DEV-1 is closed; claim release did not finish: boom\nclear it with: ${PLATFORM_SLUG} board claim release-task DEV-1 --project workshop`
  const router = createWorkRouter({
    machineAttribution: (async () => ({})) as never,
    setTaskThroughTracker: (async () => {
      throw new TaskClosedWithResidueError(closedTask, 'claim-release', message)
    }) as never,
  })

  await expect(
    router.createCaller({}).setStatus({ key: 'DEV-1', scope: {}, status: 'done' }),
  ).resolves.toEqual({
    task: closedTask,
    residueMessage: message,
  })
})

test('setStatus keeps a plain refusal as BAD_REQUEST', async () => {
  const router = createWorkRouter({
    machineAttribution: (async () => ({})) as never,
    setTaskThroughTracker: (async () => {
      throw new Error('status bogus does not resolve')
    }) as never,
  })

  await expect(
    router.createCaller({}).setStatus({ key: 'DEV-1', scope: {}, status: 'bogus' }),
  ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'status bogus does not resolve' })
})

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
