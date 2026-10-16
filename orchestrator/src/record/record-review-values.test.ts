import { expect, test } from 'bun:test'
import { commonReviewRecordValues } from './record-review-values.ts'

test('hosted review values ignore the machine-local id', () => {
  const values = commonReviewRecordValues({
    id: '01990000-0000-7000-8000-000000000001',
    spaceId: '01990000-0000-7000-8000-000000000002',
    machineId: '01990000-0000-7000-8000-000000000003',
    localId: 42,
    createdAt: '2026-10-16T18:00:00.000Z',
    updatedAt: '2026-10-16T18:00:00.000Z',
  })

  expect(values).not.toHaveProperty('localId')
})
