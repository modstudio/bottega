import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PGlite } from '@electric-sql/pglite'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { createNoDestinationWriteCounter } from '../../shared/record-no-destination-write-counter.ts'
import { forgetRecordSessionToken, writeRecordSessionToken } from '../../shared/record-session.ts'
import { createHostedRecordFixture, pgliteSql } from '../test/hosted-record-fixture.ts'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { db } from './db.ts'
import { hostedRequestHandler } from './hosted.ts'
import { applyHostedPushChanges } from './hosted-push-changes.ts'
import { listHostedTasks } from './hosted-task-list.ts'
import { createHostedDocument, createHostedTask, getHostedTask } from './hosted-tasks.ts'
import { projectRecordIdFor } from './project-record-id.ts'
import {
  commentTask,
  createTask,
  deleteTaskComment,
  editTaskComment,
  listTasks,
  setTask,
  setTaskBody,
  showTask,
  taskRecord,
} from './task.ts'
import { hostedGetTask } from './task-client.ts'
import { taskBodyVersion } from './task-detail.ts'
import { createTaskDocument, getLocalTaskDocument, updateTaskDocument } from './task-document.ts'

const spaceId = '01990000-0000-7000-8000-000000002520'
const userId = '01990000-0000-7000-8000-000000002521'
const projectId = projectRecordIdFor('gamma')
const sharedSpaceProjectId = projectRecordIdFor('eta')
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
    VALUES
      ('${projectId}','${spaceId}','gamma',ARRAY['GAM'],now()),
      ('${sharedSpaceProjectId}','${spaceId}','eta',ARRAY['ETA'],now());
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
        createDocument: createHostedDocument,
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

test('create and edit from one client store are visible in the other without pull', async () => {
  const created = await recordCreate(
    { project: 'gamma', title: 'Created from client A' },
    {
      hosted: {
        baseUrl: 'https://hub.example.test',
        token: 'test',
        fetch: recordFetch,
      },
    },
  )

  // Client B begins with no pulled task rows and reads the record directly.
  resetFixtureStore()
  expect(dbTaskCount()).toBe(0)

  const shownInB = await recordShow(created.key, { project: 'gamma' })
  expect(shownInB.task).toMatchObject({
    record_id: created.record_id,
    key: created.key,
    project: 'gamma',
    title: 'Created from client A',
  })
  expect(dbTaskCount()).toBe(0)

  await setTask(
    created.key,
    { project: 'gamma' },
    { title: 'Edited from client B' },
    { actorUserId: userId, actorName: 'Record author', agent: null, runId: null },
    { hosted: hosted(), expectedRevision: shownInB.task.revision },
  )

  // Client A also has no pulled rows when it observes B's edit.
  resetFixtureStore()
  expect(dbTaskCount()).toBe(0)
  expect((await recordShow(created.key, { project: 'gamma' })).task.title).toBe(
    'Edited from client B',
  )
  expect(dbTaskCount()).toBe(0)
})

async function createSharedSpaceTasks() {
  const gamma = await recordCreate(
    { project: 'gamma', title: 'Shared-space gamma task' },
    { hosted: hosted(), skipDuplicateCheck: true },
  )
  const eta = await recordCreate(
    { project: 'eta', title: 'Shared-space eta task' },
    { hosted: hosted(), skipDuplicateCheck: true },
  )
  return { gamma, eta }
}

test('hosted show finds each task in a shared record space without project scope', async () => {
  const { gamma, eta } = await createSharedSpaceTasks()
  expect((await recordShow(gamma.key, {})).task.record_id).toBe(gamma.record_id)
  expect((await recordShow(eta.key, {})).task.record_id).toBe(eta.record_id)
})

test('hosted list keeps only tasks from the requested project in a shared space', async () => {
  const { eta } = await createSharedSpaceTasks()
  const filtered = await recordList({ project: 'eta' })
  expect(filtered).toContainEqual(expect.objectContaining({ record_id: eta.record_id }))
  expect(filtered.every((task) => task.project === 'eta')).toBe(true)
})

test("hosted show does not return another shared-space project's task", async () => {
  const { gamma } = await createSharedSpaceTasks()
  await expect(recordShow(gamma.key, { project: 'eta' })).rejects.toThrow(`no task ${gamma.key}`)
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

test('a stale hosted body replacement names the current revision and preserves the body', async () => {
  const task = await recordCreate(
    { project: 'gamma', title: 'Revision guard', body: 'Before' },
    { hosted: hosted() },
  )
  const initialRevision = task.revision!
  const accepted = await setTaskBody(
    task.key,
    { project: 'gamma' },
    'Accepted',
    String(initialRevision),
    { hosted: hosted() },
  )
  if (accepted.revision === undefined) throw new Error('hosted task has no revision')

  const refused = await setTaskBody(
    task.key,
    { project: 'gamma' },
    'Stale',
    String(initialRevision),
    { hosted: hosted() },
  ).catch((error: unknown) => error)

  expect(refused).toBeInstanceOf(Error)
  expect((refused as Error).message).toContain(
    `hub_task ${task.record_id} changed since revision ${initialRevision}; now ${accepted.revision}.`,
  )
  await database.exec('RESET ROLE;')
  const stored = await database.query<{ body: string; revision: number }>(
    `SELECT body,revision::int revision FROM hub_task WHERE id=$1`,
    [task.record_id],
  )
  await database.exec('SET ROLE record_actor;')
  expect(stored.rows).toEqual([{ body: 'Accepted', revision: accepted.revision }])
})

test('hosted document updates use the declared space and refuse a stale version', async () => {
  const requests: Array<{ path: string; space: string | null }> = []
  const fetch = async (input: string, init?: RequestInit) => {
    if (init?.method === 'POST')
      requests.push({
        path: new URL(input).pathname,
        space: new Headers(init.headers).get('x-record-space'),
      })
    return recordFetch(input, init)
  }
  const options = {
    hosted: { baseUrl: 'https://hub.example.test', token: 'test', fetch },
  }
  const task = await recordCreate(
    { project: 'gamma', title: 'Document destination' },
    { ...options, skipDuplicateCheck: true },
  )
  const document = await createTaskDocument(
    { task: task.key, title: 'Plan', body: 'Before' },
    { project: 'gamma' },
    options,
  )

  await updateTaskDocument(
    document.id,
    { body: 'After', expectedVersion: document.version },
    { ...options, scope: { project: 'gamma' } },
  )
  expect(requests.at(-1)).toEqual({
    path: '/v1/changes',
    space: 'declared-gamma-space',
  })

  const stale = await updateTaskDocument(
    document.id,
    { body: 'Stale', expectedVersion: document.version },
    { ...options, scope: { project: 'gamma' } },
  ).catch((error: unknown) => error)
  expect(stale).toBeInstanceOf(Error)
  expect((stale as Error).message).toContain(
    `hub_task_document ${document.id} changed since revision ${document.version}`,
  )
  expect((stale as Error).message).not.toContain('Retry when the hosted record is reachable.')
})

test('hosted role writes refuse another holder before posting a document or change', async () => {
  let documentPosts = 0
  let changePosts = 0
  const fetch = async (input: string, init?: RequestInit) => {
    const path = new URL(input).pathname
    if (init?.method === 'POST' && path.endsWith('/documents')) documentPosts += 1
    if (init?.method === 'POST' && path === '/v1/changes') changePosts += 1
    return recordFetch(input, init)
  }
  const options = {
    hosted: { baseUrl: 'https://hub.example.test', token: 'test', fetch },
  }
  const task = await recordCreate(
    { project: 'gamma', title: 'One hosted role holder' },
    { ...options, skipDuplicateCheck: true },
  )
  const holder = await createTaskDocument(
    { task: task.key, title: 'Current handoff', role: 'handoff' },
    { project: 'gamma' },
    options,
  )
  const refusal = `role 'handoff' on task ${task.key} is held by ${holder.label} "Current handoff"; run \`${PLATFORM_SLUG} task doc set ${holder.label} --no-role --version ${holder.version}\`, then retry`

  const createError = await createTaskDocument(
    { task: task.key, title: 'Duplicate handoff', role: 'handoff' },
    { project: 'gamma' },
    options,
  ).catch((error: unknown) => error)
  expect(documentPosts).toBe(1)
  expect((createError as Error).message).toBe(refusal)
  expect(
    (await hostedGetTask(task.key, options.hosted)).documents.filter(
      (document) => document.role === 'handoff',
    ),
  ).toHaveLength(1)

  const other = await createTaskDocument(
    { task: task.key, title: 'Other' },
    { project: 'gamma' },
    options,
  )
  const changesBeforeRefusal = changePosts
  const updateError = await updateTaskDocument(
    other.id,
    { role: 'handoff', expectedVersion: other.version },
    { ...options, scope: { project: 'gamma' } },
  ).catch((error: unknown) => error)
  expect(changePosts).toBe(changesBeforeRefusal)
  expect((updateError as Error).message).toBe(refusal)

  const cleared = await updateTaskDocument(
    holder.id,
    { role: null, expectedVersion: holder.version },
    { ...options, scope: { project: 'gamma' } },
  )
  expect(cleared.role).toBeNull()
})

test('hosted document create demotes a role holder left stale by a hosted clear', async () => {
  const options = {
    hosted: { baseUrl: 'https://hub.example.test', token: 'test', fetch: recordFetch },
  }
  const task = await recordCreate(
    { project: 'gamma', title: 'Stale local role holder' },
    { ...options, skipDuplicateCheck: true },
  )
  const first = await createTaskDocument(
    { task: task.key, title: 'First handoff', role: 'handoff' },
    { project: 'gamma' },
    options,
  )
  await updateTaskDocument(
    first.id,
    { role: null, expectedVersion: first.version },
    { ...options, scope: { project: 'gamma' } },
  )

  const second = await createTaskDocument(
    { task: task.key, title: 'Second handoff', role: 'handoff' },
    { project: 'gamma' },
    options,
  )

  expect(getLocalTaskDocument(first.id).role).toBeNull()
  expect(getLocalTaskDocument(second.id).role).toBe('handoff')
  expect(
    (await hostedGetTask(task.key, options.hosted)).documents.filter(
      (document) => document.role === 'handoff',
    ),
  ).toHaveLength(1)
})

test('a hosted list scoped to an undeclared-space project refuses', async () => {
  await expect(listTasks({ project: 'workshop' })).rejects.toThrow(
    'project workshop has no declared record space',
  )
})

test('a hosted parent update normalizes the key and remains listable by parent', async () => {
  const parent = await recordCreate(
    { project: 'gamma', title: 'Normalize parent fixture' },
    { hosted: hosted(), skipDuplicateCheck: true },
  )
  const child = await recordCreate(
    { project: 'gamma', title: 'Normalize child fixture' },
    { hosted: hosted(), skipDuplicateCheck: true },
  )

  await setTask(
    child.key,
    { project: 'gamma' },
    { parent: parent.key.toLowerCase() },
    { actorUserId: userId, actorName: 'Record author', agent: null, runId: null },
    { hosted: hosted() },
  )

  await database.exec('RESET ROLE;')
  const stored = await database.query<{ parent_key: string }>(
    `SELECT parent_key FROM hub_task WHERE id=$1`,
    [child.record_id],
  )
  await database.exec('SET ROLE record_actor;')
  expect(stored.rows).toEqual([{ parent_key: parent.key }])
  expect(await recordList({ project: 'gamma', parent: parent.key.toLowerCase() })).toEqual([
    expect.objectContaining({ record_id: child.record_id, parent_key: parent.key }),
  ])
})

test('a rejected hosted task status change leaves no status event', async () => {
  const task = await recordCreate(
    { project: 'gamma', title: 'Deleted before status change' },
    { hosted: hosted() },
  )
  let deleted = false
  const deleteBeforePush = async (input: string, init?: RequestInit) => {
    if (!deleted && init?.method === 'POST' && input.endsWith('/v1/changes')) {
      deleted = true
      await database.exec(`
        RESET ROLE;
        UPDATE hub_task SET deleted_at=now() WHERE id='${task.record_id}';
        SET ROLE record_actor;
      `)
    }
    return recordFetch(input, init)
  }

  await expect(
    setTask(
      task.key,
      { project: 'gamma' },
      { status: 'active' },
      { actorUserId: userId, actorName: 'Record author', agent: null, runId: null },
      { hosted: { ...hosted(), fetch: deleteBeforePush } },
    ),
  ).rejects.toThrow(`task show ${task.key}`)
  await database.exec('RESET ROLE;')
  const events = await database.query<{ count: number }>(
    `SELECT count(*)::int count FROM hub_task_status_event WHERE task_id=$1`,
    [task.record_id],
  )
  await database.exec('SET ROLE record_actor;')
  expect(events.rows).toEqual([{ count: 0 }])
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

async function recordShow(key: string, scope: { project?: string }) {
  const nodeEnv = process.env.NODE_ENV
  delete process.env.NODE_ENV
  try {
    return await showTask(key, scope)
  } finally {
    if (nodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = nodeEnv
  }
}

async function recordList(filters: Parameters<typeof listTasks>[0]) {
  const nodeEnv = process.env.NODE_ENV
  delete process.env.NODE_ENV
  try {
    return await listTasks(filters)
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
