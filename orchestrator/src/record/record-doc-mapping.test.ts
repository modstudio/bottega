import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record/schema.ts'
import { recordDocRow } from './record-doc-mapping.ts'

test('document row timestamps keep milliseconds when the driver returns Dates', () => {
  const timestamp = new Date('2026-10-09T12:34:56.789Z')
  const mapped = recordDocRow({
    id: newRecordId(),
    space_id: newRecordId(),
    space_name: 'space',
    scope: 'global',
    subject: null,
    owner_user_id: null,
    slug: 'milliseconds',
    title: 'Milliseconds',
    body: 'Milliseconds survive.',
    delivery: 'demand',
    audiences: ['technical'],
    parent_id: null,
    position: 0,
    project_name: null,
    created_at: timestamp,
    updated_at: timestamp,
    deleted_at: timestamp,
  })

  expect({
    createdAt: mapped.createdAt,
    updatedAt: mapped.updatedAt,
    deletedAt: mapped.deletedAt,
  }).toEqual({
    createdAt: '2026-10-09T12:34:56.789Z',
    updatedAt: '2026-10-09T12:34:56.789Z',
    deletedAt: '2026-10-09T12:34:56.789Z',
  })
})
