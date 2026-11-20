import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PGlite } from '@electric-sql/pglite'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import {
  createHostedRecordFixture,
  pgliteSql,
} from '../../orchestrator/test/fixtures/hosted-record.ts'
import { createNoDestinationWriteCounter } from '../../shared/record-no-destination-write-counter.ts'
import { forgetRecordSessionToken, writeRecordSessionToken } from '../../shared/record-session.ts'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { db } from './db.ts'
import { hostedRequestHandler } from './hosted.ts'
import { applyHostedPushChanges } from './hosted-push-changes.ts'
import { listHostedTasks } from './hosted-task-list.ts'
import { createHostedTask, getHostedTask } from './hosted-tasks.ts'
import { projectRecordIdFor } from './project-record-id.ts'
import {
  commentTask,
  createTask,
  deleteTaskComment,
  editTaskComment,
  setTaskBody,
  showTask,
  taskRecord,
} from './task.ts'
import { taskBodyVersion } from './task-detail.ts'

const spaceId = '01990000-0000-7000-8000-000000002520'
const userId = '01990000-0000-7000-8000-000000002521'
const projectId = projectRecordIdFor('gamma')
const stateRoot = mkdtempSync(join(tmpdir(), `${PLATFORM_SLUG}-task-record-app-`))
const previous = {
  fetch: globalThis.fetch,
  hostedUrl: process.env.BOTTEGA_HOSTED_URL,
  keyStore: process.env.BOTTEGA_KEYSTORE,
  nodeEnv: process.env.NODE_ENV,
  stateHome: process.env.BOTTEGA_STATE_HOME,
}
let database: PGlite
let recordFetch: (input: string, init?: RequestInit) => Promise<Response>

beforeAll(async () => {
  database = await createHostedRecordFixture({ spaceId, userId })
  await database.exec(`
    RESET ROLE;
    UPDATE space SET slug='declared-gamma-space' WHERE id='${spaceId}';
    INSERT INTO project (id,space_id,name,key_prefixes,created_at)
    VALUES ('${projectId}','${spaceId}','gamma',ARRAY['GAM'],now());
    SET ROLE record_actor;
  `)
  const client = pgliteSql(database)
  const identityFetch = async () =>
    Response.json({
      user: { id: userId, name: 'Record author' },
      activeSpaceId: spaceId,
      memberships: [{ space_id: spaceId, slug: 'declared-gamma-space', permission: 'write' }],
    })
  const handler = hostedRequestHandler(
    {
      recordApiUrl: 'https://record.example.test',
      recordDatabaseUrl: client,
      noDestinationWriteCounter: createNoDestinationWriteCounter(),
    },
    {
      tasks: {
        fetch: identityFetch,
        create: createHostedTask,
        get: getHostedTask,
        list: listHostedTasks,
      },
      changes: { fetch: identityFetch, push: applyHostedPushChanges },
    },
  )
  const appFetch = (input: string | URL | Request, init?: RequestInit) =>
    handler(new Request(input, init))
  recordFetch = (input, init) => appFetch(input, init)
  globalThis.fetch = appFetch as typeof fetch
  process.env.BOTTEGA_HOSTED_URL = 'https://hub.example.test'
  process.env.BOTTEGA_KEYSTORE = 'file'
  process.env.BOTTEGA_STATE_HOME = stateRoot
  delete process.env.NODE_ENV
  writeRecordSessionToken('test')
  if (previous.nodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = previous.nodeEnv
})

beforeEach(resetFixtureStore)

afterAll(async () => {
  if (database) await database.close()
  globalThis.fetch = previous.fetch
  for (const [name, value] of [
    ['BOTTEGA_HOSTED_URL', previous.hostedUrl],
    ['BOTTEGA_KEYSTORE', previous.keyStore],
    ['BOTTEGA_STATE_HOME', previous.stateHome],
    ['NODE_ENV', previous.nodeEnv],
  ] as const) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  forgetRecordSessionToken()
  rmSync(stateRoot, { recursive: true, force: true })
})

test('a hosted write is immediately readable from a fresh empty local store without pull', async () => {
  const created = await recordCreate(
    { project: 'gamma', title: 'Record-authoritative acceptance' },
    {
      hosted: {
        baseUrl: 'https://hub.example.test',
        token: 'test',
        fetch: recordFetch,
      },
    },
  )

  resetFixtureStore()
  expect(dbTaskCount()).toBe(0)

  const shown = await recordShow(created.key, { project: 'gamma' })
  expect(shown.task).toMatchObject({
    record_id: created.record_id,
    key: created.key,
    project: 'gamma',
    title: 'Record-authoritative acceptance',
  })
  expect(dbTaskCount()).toBe(0)
})

const hosted = () => ({ baseUrl: 'https://hub.example.test', token: 'test', fetch: recordFetch })

test('comment authors may edit and delete while other record users are refused', async () => {
  const task = await recordCreate(
    { project: 'gamma', title: 'Comment authorship' },
    { hosted: hosted() },
  )
  const author = { actorUserId: userId, actorName: 'Record author', agent: 'codex', runId: '42' }
  const other = { ...author, actorUserId: '01990000-0000-7000-8000-000000002599' }
  const comment = await commentTask(task.key, { project: 'gamma' }, 'first', author, {
    hosted: hosted(),
  })

  await expect(
    editTaskComment(task.key, { project: 'gamma' }, comment.id, 'other', other, {
      hosted: hosted(),
      expectedRevision: comment.revision,
    }),
  ).rejects.toThrow('another author')
  const edited = await editTaskComment(
    task.key,
    { project: 'gamma' },
    comment.id,
    'edited',
    author,
    {
      hosted: hosted(),
      expectedRevision: comment.revision,
    },
  )
  expect((await recordShow(task.key, { project: 'gamma' })).comments[0]?.body).toBe('edited')
  await deleteTaskComment(task.key, { project: 'gamma' }, comment.id, author, {
    hosted: hosted(),
    expectedRevision: edited.revision,
  })
  expect((await recordShow(task.key, { project: 'gamma' })).comments).toEqual([])
})

test('hosted task body writes preserve tracker capability refusals', async () => {
  const id = '01990000-0000-7000-8000-000000002598'
  await database.exec(`
    RESET ROLE;
    INSERT INTO hub_task
      (id,space_id,project_name,project_id,key,project,title,status,status_category,source,first_seen,last_seen,created_at,updated_at)
    VALUES
      ('${id}','${spaceId}','gamma','${projectId}','GAM-998','gamma','External','open','open','mcp',now(),now(),now(),now());
    SET ROLE record_actor;
  `)
  await expect(
    setTaskBody('GAM-998', { project: 'gamma' }, 'refused', taskBodyVersion(null), {
      hosted: hosted(),
    }),
  ).rejects.toThrow('hub cannot establish what its tracker accepts')
})

test('hosted writes use the project-declared record space', async () => {
  const requests: Array<{ method: string; space: string | null }> = []
  const fetch = async (input: string, init?: RequestInit) => {
    requests.push({
      method: init?.method ?? 'GET',
      space: new Headers(init?.headers).get('x-record-space'),
    })
    return recordFetch(input, init)
  }
  const options = { hosted: { baseUrl: 'https://hub.example.test', token: 'test', fetch } }
  const task = await recordCreate({ project: 'gamma', title: 'Declared destination' }, options)
  await commentTask(
    task.key,
    { project: 'gamma' },
    'declared comment',
    { actorUserId: userId, actorName: null, agent: null, runId: null },
    options,
  )

  expect(requests.filter(({ method }) => method === 'POST').map(({ space }) => space)).toEqual([
    'declared-gamma-space',
    'declared-gamma-space',
  ])
})

test('work.task composes the hosted task, comments, documents, and project', async () => {
  const task = await recordCreate(
    { project: 'gamma', title: 'Inspectable hosted task', body: 'Task body' },
    { hosted: hosted() },
  )
  const comment = await commentTask(
    task.key,
    { project: 'gamma' },
    'A useful comment',
    { actorUserId: userId, actorName: 'Record author', agent: null, runId: null },
    { hosted: hosted() },
  )
  const documentId = '01990000-0000-7000-8000-000000002597'
  await database.exec(`
    RESET ROLE;
    INSERT INTO hub_task_document
      (id,space_id,project_name,project_id,task_key,task_id,number,role,title,body,version,created_at,updated_at)
    VALUES
      ('${documentId}','${spaceId}','gamma','${projectId}','${task.key}','${task.record_id}',1,'handoff','Handoff','# Handoff','v1',now(),now());
    SET ROLE record_actor;
  `)
  const result = await recordTaskRecord(task.key, { project: 'gamma' }, userId)
  expect(result.task).toMatchObject({ key: task.key, project: 'gamma' })
  expect(result.comments).toEqual([expect.objectContaining({ id: comment.id, canEdit: true })])
  expect(result.documents).toEqual([expect.objectContaining({ id: documentId, body: '# Handoff' })])
  expect(result.runs).toEqual([])
})

function dbTaskCount(): number {
  return db().query<{ count: number }, []>('SELECT count(*) count FROM task').get()!.count
}

async function recordShow(key: string, scope: { project: string }) {
  const nodeEnv = process.env.NODE_ENV
  delete process.env.NODE_ENV
  try {
    return await showTask(key, scope)
  } finally {
    if (nodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = nodeEnv
  }
}

async function recordCreate(
  input: Parameters<typeof createTask>[0],
  options: Parameters<typeof createTask>[1],
) {
  const nodeEnv = process.env.NODE_ENV
  delete process.env.NODE_ENV
  try {
    return await createTask(input, options)
  } finally {
    if (nodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = nodeEnv
  }
}

async function recordTaskRecord(key: string, scope: { project: string }, readerUserId: string) {
  const nodeEnv = process.env.NODE_ENV
  delete process.env.NODE_ENV
  try {
    return await taskRecord(key, scope, readerUserId)
  } finally {
    if (nodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = nodeEnv
  }
}
