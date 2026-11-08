import { expect, spyOn, test } from 'bun:test'
import { newRecordId } from '../../../shared/record/schema.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { db } from '../database/db.ts'
import { pullRecordCache } from './record-cache.ts'
import { decodeRecordCursor, encodeRecordCursor, type RecordCursor } from './record-cursor.ts'

const updatedAt = '2026-10-09T12:34:56.789Z'
const firstCursorAt = '2026-10-09T12:34:56.789123Z'
const secondCursorAt = '2026-10-09T12:34:56.789456Z'

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
  const firstNextCursor = btoa(JSON.stringify({ id: firstId, at: firstCursorAt }))
  const seen: Array<RecordCursor | undefined> = []
  const seenRequests: Array<string | null | undefined> = []
  const client = createMemoryRecordApiClient()
  installRecordApiClient({
    ...client,
    listDocs: async (query) => {
      seenRequests.push(query.cursor)
      const after = cursor(query.cursor)
      seen.push(after)
      if (!after)
        return {
          items: [doc(firstId, 'first')],
          nextCursor: firstNextCursor,
          endCursor: encodeRecordCursor({ at: firstCursorAt, id: firstId }),
        }
      if (after.id === firstId)
        return {
          items: [doc(secondId, 'second')],
          nextCursor: null,
          endCursor: encodeRecordCursor({ at: secondCursorAt, id: secondId }),
        }
      return { items: [], nextCursor: null }
    },
  })

  expect(await pullRecordCache(db())).toMatchObject({ docs: 2 })
  expect(await pullRecordCache(db())).toMatchObject({ docs: 0 })
  expect(
    db().query<{ record_id: string }, []>('SELECT record_id FROM doc ORDER BY slug').all(),
  ).toEqual([{ record_id: firstId }, { record_id: secondId }])
  expect(seen).toEqual([
    undefined,
    { at: firstCursorAt, id: firstId },
    { at: secondCursorAt, id: secondId },
  ])
  expect(seenRequests[1]).toBe(firstNextCursor)
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
          nextCursor: encodeRecordCursor({ at: firstCursorAt, id: firstId }),
          endCursor: encodeRecordCursor({ at: firstCursorAt, id: firstId }),
        }
      if (!interrupted) {
        interrupted = true
        throw new Error('simulated restart')
      }
      return {
        items: [doc(secondId, 'second')],
        nextCursor: null,
        endCursor: encodeRecordCursor({ at: secondCursorAt, id: secondId }),
      }
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
  ).toEqual({ at: firstCursorAt, id: firstId })

  expect(await pullRecordCache(db())).toMatchObject({ docs: 1 })
  expect(seen).toEqual([
    undefined,
    { at: firstCursorAt, id: firstId },
    { at: firstCursorAt, id: firstId },
  ])
  expect(db().query('SELECT record_id FROM doc').all()).toHaveLength(2)
})

test('an unreadable document is warned about without advancing the persisted cursor past it', async () => {
  const readableId = newRecordId()
  const unreadableId = newRecordId()
  const warning = `hosted document project/example/bad (${unreadableId}) column doc.source_files is not a JSON list`
  const client = createMemoryRecordApiClient()
  installRecordApiClient({
    ...client,
    listDocs: async () => ({
      items: [doc(readableId, 'readable-after-bad')],
      unreadable: [{ id: unreadableId, reason: warning }],
      nextCursor: null,
      endCursor: null,
    }),
  })
  const warnings: string[] = []
  const warn = spyOn(console, 'warn').mockImplementation((message?: unknown) => {
    warnings.push(String(message))
  })
  try {
    expect(await pullRecordCache(db())).toMatchObject({ docs: 1 })
  } finally {
    warn.mockRestore()
  }
  expect(warnings).toEqual([`unreadable hosted document ${unreadableId}: ${warning}`])
  expect(
    db()
      .query(
        "SELECT value FROM schema_meta WHERE key='record_docs_cursor:01990000-0000-7000-8000-000000000002'",
      )
      .get(),
  ).toBeNull()
})

test('an unreadable first page freezes the persisted cursor while the pull walks later pages', async () => {
  const beforeUnreadableId = newRecordId()
  const unreadableId = newRecordId()
  const laterId = newRecordId()
  const firstPageCursor = encodeRecordCursor({ at: firstCursorAt, id: unreadableId })
  const seen: Array<RecordCursor | undefined> = []
  const client = createMemoryRecordApiClient()
  installRecordApiClient({
    ...client,
    listDocs: async (query) => {
      const after = cursor(query.cursor)
      seen.push(after)
      if (!after)
        return {
          items: [doc(beforeUnreadableId, 'before-unreadable')],
          unreadable: [{ id: unreadableId, reason: 'bad source_files' }],
          nextCursor: firstPageCursor,
          endCursor: encodeRecordCursor({ at: firstCursorAt, id: beforeUnreadableId }),
        }
      return {
        items: [doc(laterId, 'later-readable')],
        nextCursor: null,
        endCursor: encodeRecordCursor({ at: secondCursorAt, id: laterId }),
      }
    },
  })
  const warn = spyOn(console, 'warn').mockImplementation(() => {})
  try {
    expect(await pullRecordCache(db())).toMatchObject({ docs: 2 })
  } finally {
    warn.mockRestore()
  }
  expect(seen).toEqual([undefined, { at: firstCursorAt, id: unreadableId }])
  expect(
    JSON.parse(
      db()
        .query<{ value: string }, []>(
          "SELECT value FROM schema_meta WHERE key='record_docs_cursor:01990000-0000-7000-8000-000000000002'",
        )
        .get()!.value,
    ),
  ).toEqual({ at: firstCursorAt, id: beforeUnreadableId })
})
