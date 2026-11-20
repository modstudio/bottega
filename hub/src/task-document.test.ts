import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { declareFixtureProjectSpace } from '../test/fixture-project-space.ts'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { writeTransaction } from './db.ts'
import { createTask } from './task.ts'
import {
  createTaskDocument,
  deleteTaskDocument,
  getTaskDocument,
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
