import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { declareFixtureProjectSpace } from '../test/fixture-project-space.ts'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { db, writeTransaction } from './db.ts'
import { createTask } from './task.ts'
import {
  createTaskDocument,
  deleteTaskDocument,
  getTaskDocument,
  listTaskDocuments,
  updateTaskDocument,
} from './task-document.ts'

declareFixtureProjectSpace('workshop', 'workshop')

const seed = (key: string, project: string) => {
  const stamp = new Date().toISOString()
  const recordId = Bun.randomUUIDv7()
  writeTransaction((conn) =>
    conn
      .query(
        `INSERT INTO task
        (record_id,key,project,title,status,status_category,source,first_seen,last_seen)
        VALUES (?, ?, ?, 'seed', 'open', 'open', 'local', ?, ?)`,
      )
      .run(recordId, key, project, stamp, stamp),
  )
  return recordId
}

const hostedTaskId = '01990000-0000-7000-8000-000000252701'
const hostedDocumentId = '01990000-0000-7000-8000-000000252702'
const hostedStamp = '2026-11-01T00:00:00.000Z'
const hostedTask = {
  id: hostedTaskId,
  key: 'LOC-2527',
  project: 'workshop',
  project_name: 'workshop',
  title: 'record task',
  status: 'open',
  status_category: 'open',
  parent_key: null,
  body: null,
  assignee: null,
  opened_at: hostedStamp,
  closed_at: null,
  source: 'local',
  first_seen: hostedStamp,
  last_seen: hostedStamp,
  created_at: hostedStamp,
  updated_at: hostedStamp,
  deleted_at: null,
  next_document_number: 2,
}
const hostedDocument = {
  id: hostedDocumentId,
  number: 1,
  task_key: hostedTask.key,
  task_id: hostedTaskId,
  project_name: 'workshop',
  role: 'handoff',
  title: 'Plan',
  body: 'record body',
  version: 'v-record',
  created_at: hostedStamp,
  updated_at: hostedStamp,
  deleted_at: null,
}

function recordOnlyDocumentStub() {
  const requests: { method: string; path: string; body?: unknown }[] = []
  const fetch = async (input: string | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    requests.push({ method, path, ...(body === undefined ? {} : { body }) })
    if (path === `/v1/tasks/${hostedTask.key}`)
      return Response.json({ task: hostedTask, comments: [], documents: [hostedDocument] })
    if (path === '/v1/changes') {
      const changes = body as { id: string; expected_revision?: string }[]
      return Response.json(
        changes.map(({ id, expected_revision }) =>
          expected_revision !== undefined && expected_revision !== hostedDocument.version
            ? {
                id,
                status: 'rejected',
                reason: `revision conflict: expected ${expected_revision}, current ${hostedDocument.version}`,
              }
            : { id, status: 'applied' },
        ),
      )
    }
    return new Response('{"error":"not found"}', { status: 404 })
  }
  return {
    requests,
    hosted: { baseUrl: 'https://hub.example.test', token: 'test', fetch },
  }
}

const documentOutboxRows = () =>
  db()
    .query(`SELECT table_name,operation FROM hosted_outbox WHERE table_name='hub_task_document'`)
    .all()

const mirroredDocumentRows = () =>
  db().query(`SELECT record_id FROM task_document WHERE record_id=?`).all(hostedDocumentId)

describe('task documents', () => {
  const previousHostedUrl = process.env.BOTTEGA_HOSTED_URL

  beforeAll(() => {
    delete process.env.BOTTEGA_HOSTED_URL
  })
  beforeEach(resetFixtureStore)
  afterAll(() => {
    if (previousHostedUrl === undefined) delete process.env.BOTTEGA_HOSTED_URL
    else process.env.BOTTEGA_HOSTED_URL = previousHostedUrl
  })

  test('creates, updates with versioning, and deletes a local document', async () => {
    const task = await createTask({
      project: 'beta',
      title: 'Document service lifecycle',
    })
    const document = await createTaskDocument(
      { task: task.key, title: 'Notes', body: 'first body' },
      {},
    )
    expect(document.body).toBe('first body')

    const updated = await updateTaskDocument(document.id, {
      body: 'second body',
      expectedVersion: document.version,
    })
    expect(updated.body).toBe('second body')
    expect(updated.version).not.toBe(document.version)
    await expect(
      updateTaskDocument(document.id, {
        body: 'stale',
        expectedVersion: document.version,
      }),
    ).rejects.toThrow(`task document ${document.id} changed since version ${document.version}`)

    await deleteTaskDocument(document.id)
    await expect(getTaskDocument(document.id)).rejects.toThrow(`no task document ${document.id}`)
  })

  test('never reuses document numbers after deletion', async () => {
    const task = await createTask({
      project: 'beta',
      title: 'Stable document numbers',
    })
    const first = await createTaskDocument({ task: task.key, title: 'One' }, {})
    const second = await createTaskDocument({ task: task.key, title: 'Two' }, {})
    const third = await createTaskDocument({ task: task.key, title: 'Three' }, {})
    await deleteTaskDocument(second.id)
    const fourth = await createTaskDocument({ task: task.key, title: 'Four' }, {})

    expect([first.number, third.number, fourth.number]).toEqual([1, 3, 4])
    expect([first.label, third.label, fourth.label]).toEqual([
      `${task.key}/1`,
      `${task.key}/3`,
      `${task.key}/4`,
    ])
  })

  test('allocates from a stored counter above every live document number', async () => {
    const taskRecordId = seed('BET-1214', 'beta')
    writeTransaction((conn) =>
      conn.query(`UPDATE task SET next_document_number=9 WHERE record_id=?`).run(taskRecordId),
    )

    const document = await createTaskDocument(
      { task: 'BET-1214', title: 'After deleted history' },
      { recordId: taskRecordId },
    )
    expect(document.number).toBe(9)
  })

  test('local role writes refuse another holder without changing either row', async () => {
    const task = await createTask({ project: 'beta', title: 'One role holder' })
    const holder = await createTaskDocument(
      { task: task.key, title: 'Current handoff', role: 'handoff' },
      {},
    )
    const refusal = `role 'handoff' on task ${task.key} is held by ${holder.label} "Current handoff"; run \`${PLATFORM_SLUG} task doc set ${holder.label} --no-role --version ${holder.version}\`, then retry`

    const createError = await createTaskDocument(
      { task: task.key, title: 'Duplicate handoff', role: 'handoff' },
      {},
    ).catch((error: unknown) => error)
    expect((createError as Error).message).toBe(refusal)

    const other = await createTaskDocument({ task: task.key, title: 'Other' }, {})
    expect(other.number).toBe(2)
    const updateError = await updateTaskDocument(other.id, { role: 'handoff' }).catch(
      (error: unknown) => error,
    )
    expect((updateError as Error).message).toBe(refusal)
    expect(await getTaskDocument(other.id)).toEqual(other)

    expect((await updateTaskDocument(holder.id, { role: 'handoff' })).role).toBe('handoff')
    expect((await updateTaskDocument(holder.id, { role: null })).role).toBeNull()
  })

  test('hosted set resolves a record-only label and returns the changed document', async () => {
    const stub = recordOnlyDocumentStub()
    const updated = await updateTaskDocument(
      'LOC-2527/1',
      { body: 'after', expectedVersion: hostedDocument.version },
      { hosted: stub.hosted },
    )

    expect(updated.body).toBe('after')
    expect(updated.version).not.toBe(hostedDocument.version)
    expect(stub.requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'GET /v1/tasks/LOC-2527',
      'POST /v1/changes',
    ])
    expect(mirroredDocumentRows()).toEqual([])
    expect(documentOutboxRows()).toEqual([])
  })

  test('hosted --no-role clears a record-only document role', async () => {
    const stub = recordOnlyDocumentStub()
    const updated = await updateTaskDocument(
      'LOC-2527/1',
      { role: null, expectedVersion: hostedDocument.version },
      { hosted: stub.hosted },
    )

    expect(updated.role).toBeNull()
    expect(stub.requests.at(-1)?.body).toEqual([
      expect.objectContaining({ fields: ['role'], expected_revision: hostedDocument.version }),
    ])
    expect(mirroredDocumentRows()).toEqual([])
  })

  test('hosted set reports a stale record-only document version', async () => {
    const stub = recordOnlyDocumentStub()
    await expect(
      updateTaskDocument(
        'LOC-2527/1',
        { body: 'after', expectedVersion: 'v-old' },
        { hosted: stub.hosted },
      ),
    ).rejects.toThrow('revision conflict: expected v-old, current v-record')
    expect(stub.requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'GET /v1/tasks/LOC-2527',
      'POST /v1/changes',
    ])
    expect(documentOutboxRows()).toEqual([])
  })

  test('hosted delete sends the record version and never queues', async () => {
    const stub = recordOnlyDocumentStub()
    const removed = await deleteTaskDocument('LOC-2527/1', { hosted: stub.hosted })

    expect(removed.body).toBe(hostedDocument.body)
    expect(stub.requests.at(-1)?.body).toEqual([
      expect.objectContaining({
        table: 'hub_task_document',
        id: hostedDocumentId,
        op: 'delete',
        expected_revision: hostedDocument.version,
      }),
    ])
    expect(mirroredDocumentRows()).toEqual([])
    expect(documentOutboxRows()).toEqual([])
  })

  test('hosted delete removes an existing mirror after the record accepts it', async () => {
    const taskRecordId = seed(hostedTask.key, hostedTask.project)
    writeTransaction((conn) =>
      conn
        .query(
          `INSERT INTO task_document
            (record_id,task_key,task_record_id,number,role,title,body,version,created_at,updated_at)
           VALUES (?,?,?,1,NULL,'Plan','record body','v-record',?,?)`,
        )
        .run(hostedDocumentId, hostedTask.key, taskRecordId, hostedStamp, hostedStamp),
    )
    const stub = recordOnlyDocumentStub()

    await deleteTaskDocument('LOC-2527/1', { hosted: stub.hosted })

    expect(mirroredDocumentRows()).toEqual([])
    expect(documentOutboxRows()).toEqual([])
  })

  test('hosted delete leaves a local mirror untouched when the record is unreachable', async () => {
    const taskRecordId = seed(hostedTask.key, hostedTask.project)
    writeTransaction((conn) =>
      conn
        .query(
          `INSERT INTO task_document
            (record_id,task_key,task_record_id,number,role,title,body,version,created_at,updated_at)
           VALUES (?,?,?,1,NULL,'Plan','record body','v-record',?,?)`,
        )
        .run(hostedDocumentId, hostedTask.key, taskRecordId, hostedStamp, hostedStamp),
    )

    await expect(
      deleteTaskDocument('LOC-2527/1', {
        hosted: {
          baseUrl: 'https://hub.example.test',
          token: 'test',
          fetch: async () => {
            throw new Error('hosted hub unavailable')
          },
        },
      }),
    ).rejects.toThrow('hosted hub unavailable')
    expect(mirroredDocumentRows()).toHaveLength(1)
    expect(documentOutboxRows()).toEqual([])
  })

  test('hosted show and list return a record-only document', async () => {
    const stub = recordOnlyDocumentStub()
    const shown = await getTaskDocument('LOC-2527/1', {}, stub.hosted)
    const listed = await listTaskDocuments(hostedTask.key, {}, stub.hosted)

    expect(shown).toMatchObject({ id: hostedDocumentId, body: 'record body', version: 'v-record' })
    expect(listed).toEqual([expect.objectContaining({ id: hostedDocumentId, number: 1 })])
    expect(stub.requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'GET /v1/tasks/LOC-2527',
      'GET /v1/tasks/LOC-2527',
    ])
    expect(mirroredDocumentRows()).toEqual([])
  })

  test('hosted UUID resolution refuses when this machine has no mirror row', async () => {
    const stub = recordOnlyDocumentStub()
    await expect(getTaskDocument(hostedDocumentId, {}, stub.hosted)).rejects.toThrow(
      `use the label <KEY>/<n>; this machine has not pulled document ${hostedDocumentId}`,
    )
    expect(stub.requests).toEqual([])
  })

  test('a hosted document update is applied to the local mirror after the send succeeds', async () => {
    const taskKey = 'SHOP-2560'
    const taskRecordId = seed(taskKey, 'workshop')
    const documentId = Bun.randomUUIDv7()
    const createdAt = '2026-01-01T00:00:00.000Z'
    writeTransaction((conn) =>
      conn
        .query(
          `INSERT INTO task_document
            (record_id,task_key,task_record_id,number,role,title,body,version,created_at,updated_at)
           VALUES (?, ?, ?, 1, NULL, 'Plan', 'before', 'version-before', ?, ?)`,
        )
        .run(documentId, taskKey, taskRecordId, createdAt, createdAt),
    )
    const document = await getTaskDocument(documentId)
    const fetch = async (_input: string, init?: RequestInit) => {
      if (!init?.body)
        return Response.json({
          task: { ...hostedTask, id: taskRecordId, key: taskKey },
          comments: [],
          documents: [
            {
              ...hostedDocument,
              id: documentId,
              task_key: taskKey,
              task_id: taskRecordId,
              body: document.body,
              version: document.version,
            },
          ],
        })
      const changes = JSON.parse(String(init?.body)) as Array<{ id: string }>
      return Response.json(changes.map(({ id }) => ({ id, status: 'applied' })))
    }

    const updated = await updateTaskDocument(
      documentId,
      { body: 'after', expectedVersion: document.version },
      {
        hosted: {
          baseUrl: 'https://hub.example.test',
          token: 'test',
          fetch,
        },
      },
    )
    const mirrored = await getTaskDocument(documentId)

    expect(mirrored.body).toBe('after')
    expect(mirrored.version).toBe(updated.version)
    expect(mirrored.version).not.toBe(document.version)
    expect(Date.parse(mirrored.updated_at)).toBeGreaterThan(Date.parse(mirrored.created_at))
  })

  test("a hosted title-only update keeps the mirror's version", async () => {
    const taskKey = 'SHOP-2561'
    const taskRecordId = seed(taskKey, 'workshop')
    const documentId = Bun.randomUUIDv7()
    const createdAt = '2026-01-01T00:00:00.000Z'
    writeTransaction((conn) =>
      conn
        .query(
          `INSERT INTO task_document
            (record_id,task_key,task_record_id,number,role,title,body,version,created_at,updated_at)
           VALUES (?, ?, ?, 1, NULL, 'Plan', 'body', 'version-before', ?, ?)`,
        )
        .run(documentId, taskKey, taskRecordId, createdAt, createdAt),
    )
    const document = await getTaskDocument(documentId)
    const fetch = async (_input: string, init?: RequestInit) => {
      if (!init?.body)
        return Response.json({
          task: { ...hostedTask, id: taskRecordId, key: taskKey },
          comments: [],
          documents: [
            {
              ...hostedDocument,
              id: documentId,
              task_key: taskKey,
              task_id: taskRecordId,
              body: document.body,
              version: document.version,
            },
          ],
        })
      const changes = JSON.parse(String(init?.body)) as Array<{ id: string }>
      return Response.json(changes.map(({ id }) => ({ id, status: 'applied' })))
    }

    const updated = await updateTaskDocument(
      documentId,
      { title: 'Renamed', expectedVersion: document.version },
      {
        hosted: {
          baseUrl: 'https://hub.example.test',
          token: 'test',
          fetch,
        },
      },
    )

    expect(updated.title).toBe('Renamed')
    expect((await getTaskDocument(documentId)).version).toBe(document.version)
  })

  test('document creation still needs the hosted record while offline', async () => {
    const id = seed('GAM-71', 'gamma')
    await expect(
      createTaskDocument(
        { task: 'GAM-71', title: 'Cannot create offline' },
        { recordId: id },
        {
          hosted: {
            baseUrl: 'https://unreachable.example.test',
            token: 'test',
            fetch: async () => {
              throw new Error('hosted hub unavailable')
            },
          },
        },
      ),
    ).rejects.toThrow('hosted hub unavailable')
  })
})
