import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { upsertRecordContextItem } from './record-context-items.ts'

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
