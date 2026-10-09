import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { writeTransaction } from './db.ts'
import { createTask, showTask } from './task.ts'
import {
  createTaskDocument,
  deleteTaskDocument,
  getTaskDocument,
  updateTaskDocument,
} from './task-document.ts'

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

describe('task documents', () => {
  const previousHostedUrl = process.env.HUB_HOSTED_URL

  beforeAll(() => {
    delete process.env.HUB_HOSTED_URL
  })
  beforeEach(resetFixtureStore)
  afterAll(() => {
    if (previousHostedUrl === undefined) delete process.env.HUB_HOSTED_URL
    else process.env.HUB_HOSTED_URL = previousHostedUrl
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
    expect(() => getTaskDocument(document.id)).toThrow(`no task document ${document.id}`)
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

  test('updates a synchronized document through its hosted UUID', async () => {
    const taskRecordId = seed('DEV-884', 'workshop')
    const at = new Date().toISOString()
    const recordId = '01990000-0000-7000-8000-000000000884'
    writeTransaction((conn) =>
      conn
        .query(
          `INSERT INTO task_document
          (record_id,task_key,task_record_id,number,title,body,version,created_at,updated_at)
          VALUES (?, 'DEV-884', ?, 1, 'Before', 'Body', 'version-before', ?, ?)`,
        )
        .run(recordId, taskRecordId, at, at),
    )
    const requests: Array<{ method: string | undefined; pathname: string }> = []

    await updateTaskDocument(
      recordId,
      { title: 'After' },
      {
        hosted: {
          baseUrl: 'https://hub.example.test',
          token: 'test',
          fetch: async (input, init) => {
            const url = new URL(input)
            requests.push({ method: init?.method, pathname: url.pathname })
            return Response.json({
              id: recordId,
              task_key: 'DEV-884',
              project_name: 'workshop',
              number: 1,
              role: null,
              title: 'After',
              body: 'Body',
              version: 'version-after',
              created_at: at,
              updated_at: at,
              deleted_at: null,
            })
          },
        },
      },
    )

    expect(requests).toEqual([
      { method: 'PATCH', pathname: `/v1/tasks/DEV-884/documents/${recordId}` },
    ])
  })

  test('hosted document writes use the project declared space', async () => {
    seed('GAM-1214', 'gamma')
    const requests: Array<{
      method: string
      pathname: string
      space: string | null
    }> = []
    const fetch = async (input: string, init?: RequestInit) => {
      const url = new URL(input)
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : {}
      requests.push({
        method,
        pathname: url.pathname,
        space: new Headers(init?.headers).get('x-record-space'),
      })
      if (method === 'POST') {
        const at = new Date().toISOString()
        return Response.json({
          id: Bun.randomUUIDv7(),
          task_key: 'GAM-1214',
          project_name: 'gamma',
          number: showTask('GAM-1214').task.next_document_number,
          role: null,
          title: body.title,
          body: body.body,
          version: body.version,
          created_at: at,
          updated_at: at,
          deleted_at: null,
        })
      }
      if (method === 'PATCH') {
        const id = decodeURIComponent(url.pathname.split('/').at(-1)!)
        const current = getTaskDocument(id)
        return Response.json({
          ...current,
          project_name: 'gamma',
          body: body.body,
          version: body.version,
          updated_at: new Date().toISOString(),
          deleted_at: null,
        })
      }
      return Response.json({ deleted: 1 })
    }
    const options = {
      hosted: { baseUrl: 'https://hub.example.test', token: 'test', fetch },
    }

    const document = await createTaskDocument(
      { task: 'GAM-1214', title: 'Declared space notes', body: 'first body' },
      {},
      options,
    )
    await updateTaskDocument(
      document.id,
      { body: 'second body', expectedVersion: document.version },
      options,
    )
    await deleteTaskDocument(document.id, options)

    expect(requests).toEqual([
      {
        method: 'POST',
        pathname: '/v1/tasks/GAM-1214/documents',
        space: 'declared-gamma-space',
      },
      {
        method: 'PATCH',
        pathname: `/v1/tasks/GAM-1214/documents/${document.id}`,
        space: 'declared-gamma-space',
      },
      {
        method: 'DELETE',
        pathname: `/v1/tasks/GAM-1214/documents/${document.id}`,
        space: 'declared-gamma-space',
      },
    ])
  })
})
