import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record/schema.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { db } from '../database/db.ts'
import { pullRecordCache } from './record-cache.ts'
import { decodeRecordCursor, encodeRecordCursor, type RecordCursor } from './record-cursor.ts'

const updatedAt = '2026-10-09T12:34:56.789Z'

function doc(id: string, slug: string): Record<string, unknown> {
  return {
    id,
    scope: 'global',
    subject: null,
    owner: null,
    slug,
    title: slug,
    body: slug,
    delivery: 'demand',
    audiences: ['technical'],
    parentId: null,
    position: 0,
    updatedAt,
    deletedAt: null,
  }
}

function cursor(value?: string | null): RecordCursor | undefined {
  return value ? decodeRecordCursor(value) : undefined
}

test('pulls every equal-timestamp document exactly once across a page boundary', async () => {
  const firstId = newRecordId()
  const secondId = newRecordId()
  const seen: Array<RecordCursor | undefined> = []
  const client = createMemoryRecordApiClient()
  installRecordApiClient({
    ...client,
    listDocs: async (query) => {
      const after = cursor(query.cursor)
      seen.push(after)
      if (!after)
        return {
          items: [doc(firstId, 'first')],
          nextCursor: encodeRecordCursor({ at: updatedAt, id: firstId }),
        }
      if (after.id === firstId) return { items: [doc(secondId, 'second')], nextCursor: null }
      return { items: [], nextCursor: null }
    },
  })

  expect(await pullRecordCache(db())).toMatchObject({ docs: 2 })
  expect(await pullRecordCache(db())).toMatchObject({ docs: 0 })
  expect(
    db().query<{ record_id: string }, []>('SELECT record_id FROM doc ORDER BY slug').all(),
  ).toEqual([{ record_id: firstId }, { record_id: secondId }])
  expect(seen).toEqual([undefined, { at: updatedAt, id: firstId }, { at: updatedAt, id: secondId }])
})

test('an empty final page ends the document pull', async () => {
  const id = newRecordId()
  let calls = 0
  const client = createMemoryRecordApiClient()
  installRecordApiClient({
    ...client,
    listDocs: async (query) => {
      calls++
      return query.cursor
        ? { items: [], nextCursor: null }
        : {
            items: [doc(id, 'only')],
            nextCursor: encodeRecordCursor({ at: updatedAt, id }),
          }
    },
  })

  expect(await pullRecordCache(db())).toMatchObject({ docs: 1 })
  expect(calls).toBe(2)
})

test('resumes the document pull from its persisted cursor after a restart between pages', async () => {
  const firstId = newRecordId()
  const secondId = newRecordId()
  let interrupted = false
  const seen: Array<RecordCursor | undefined> = []
  const client = createMemoryRecordApiClient()
  installRecordApiClient({
    ...client,
    listDocs: async (query) => {
      const after = cursor(query.cursor)
      seen.push(after)
      if (!after)
        return {
          items: [doc(firstId, 'first')],
          nextCursor: encodeRecordCursor({ at: updatedAt, id: firstId }),
        }
      if (!interrupted) {
        interrupted = true
        throw new Error('simulated restart')
      }
      return { items: [doc(secondId, 'second')], nextCursor: null }
    },
  })

  await expect(pullRecordCache(db())).rejects.toThrow('simulated restart')
  expect(
    JSON.parse(
      db()
        .query<{ value: string }, []>(
          "SELECT value FROM schema_meta WHERE key='record_docs_cursor:01990000-0000-7000-8000-000000000002'",
        )
        .get()!.value,
    ),
  ).toEqual({ at: updatedAt, id: firstId })

  expect(await pullRecordCache(db())).toMatchObject({ docs: 1 })
  expect(seen).toEqual([undefined, { at: updatedAt, id: firstId }, { at: updatedAt, id: firstId }])
  expect(db().query('SELECT record_id FROM doc').all()).toHaveLength(2)
})
