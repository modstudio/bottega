import { describe, expect, test } from 'bun:test'
import { hostedTaskBatch } from './task-hosted-record.ts'
import type { TaskRow } from './task-row.ts'

const current: TaskRow = {
  record_id: '01990000-0000-7000-8000-000000000001',
  external_id: null,
  key: 'DEV-1',
  project: 'alpha',
  project_record_id: '01990000-0000-7000-8000-000000000002',
  title: 'Before',
  status: 'open',
  status_category: 'open',
  parent_key: 'DEV-0',
  parent_record_id: null,
  body: 'Body',
  assignee: 'Sam',
  opened_at: '2026-11-20T00:00:00.000Z',
  closed_at: null,
  updated_at: '2026-11-20T00:00:00.000Z',
  source: 'local',
  first_seen: '2026-11-20T00:00:00.000Z',
  last_seen: '2026-11-20T00:00:00.000Z',
  next_document_number: 1,
  retired_reason: null,
  revision: 7,
}

describe('hosted task patch payload', () => {
  test('carries the command read values only for patched scalar fields', () => {
    const [change] = hostedTaskBatch({
      current,
      changes: { status: 'active', parent: null, assignee: 'Lee' },
      category: 'active',
      at: '2026-11-20T01:00:00.000Z',
      attribution: { actorUserId: null, actorName: null, agent: null, runId: null },
    })

    expect(change).toMatchObject({
      table: 'hub_task',
      fields: ['status', 'status_category', 'parent_key', 'assignee'],
      from: {
        status: 'open',
        status_category: 'open',
        parent_key: 'DEV-0',
        assignee: 'Sam',
      },
    })
    expect(change).not.toHaveProperty('expected_revision')
  })

  test('carries the displayed revision for text replacement', () => {
    const [change] = hostedTaskBatch({
      current,
      changes: { title: 'After', body: 'Next body' },
      category: 'open',
      at: '2026-11-20T01:00:00.000Z',
      attribution: { actorUserId: null, actorName: null, agent: null, runId: null },
      expectedRevision: 7,
    })

    expect(change).toMatchObject({
      fields: ['title', 'body'],
      expected_revision: 7,
    })
    expect(change).not.toHaveProperty('from')
  })
})
