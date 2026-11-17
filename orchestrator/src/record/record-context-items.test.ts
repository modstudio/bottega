import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { DocRevisionConflictError } from '../doc/doc-revision-conflict.ts'
import { assertRecordContextItemRevision, upsertRecordContextItem } from './record-context-items.ts'

test('hosted context-item revisions allow matching or unconditional writes and type conflicts', () => {
  expect(() => assertRecordContextItemRevision(undefined, 'current')).not.toThrow()
  expect(() => assertRecordContextItemRevision('current', 'current')).not.toThrow()
  try {
    assertRecordContextItemRevision('stale', 'current')
    throw new Error('expected revision conflict')
  } catch (error) {
    expect(error).toBeInstanceOf(DocRevisionConflictError)
    expect(error).toMatchObject({
      status: 409,
      currentRevision: 'current',
      message: expect.stringContaining('bottega agent context show'),
    })
  }
})

test('hosted context-item upsert refuses a malformed row before opening Postgres', async () => {
  await expect(
    upsertRecordContextItem({
      url: 'postgres://unused.invalid/record',
      userId: newRecordId(),
      spaceId: newRecordId(),
      holderKind: 'task',
      holderId: newRecordId(),
      slug: 'ruling',
      kind: 'ruling',
      body: 'Approved.',
      source: 'not-a-ruling-source',
      questionNumber: null,
      target: null,
    }),
  ).rejects.toThrow('a ruling source names where it was given')
})

test('hosted context-item upsert refuses derived columns that disagree before opening Postgres', async () => {
  const common = {
    url: 'postgres://unused.invalid/record',
    userId: newRecordId(),
    spaceId: newRecordId(),
    holderKind: 'task' as const,
    holderId: newRecordId(),
    slug: 'derived',
  }
  await expect(
    upsertRecordContextItem({
      ...common,
      kind: 'position',
      body: 'Approved.',
      source: 'q7000',
      questionNumber: 123,
      target: null,
    }),
  ).rejects.toThrow('question number does not match')
  await expect(
    upsertRecordContextItem({
      ...common,
      kind: 'pointer',
      body: 'doc:01990000-0000-7000-8000-000000000001',
      source: 'test',
      questionNumber: null,
      target: 'doc:01990000-0000-7000-8000-000000000002',
    }),
  ).rejects.toThrow('target does not match')
})
