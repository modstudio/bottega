import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { type HostedPushChange, parseHostedPushItem } from './push-contract.ts'

const at = '2026-10-11T12:00:00.000Z'
const id = '01990000-0000-7000-8000-000000000030'
const task: HostedPushChange = {
  table: 'hub_task',
  id,
  op: 'upsert',
  row: {
    id,
    key: 'DEV-30',
    project: PLATFORM_SLUG,
    project_name: PLATFORM_SLUG,
    title: null,
    status: null,
    status_category: null,
    parent_key: null,
    parent_id: null,
    body: null,
    assignee: null,
    opened_at: at,
    closed_at: null,
    source: 'git',
    first_seen: at,
    last_seen: at,
    created_at: at,
    updated_at: at,
    deleted_at: null,
    next_document_number: 1,
  },
}

test('task push validation accepts the mirror row and rejects every non-string edge shape', () => {
  expect(parseHostedPushItem(task)).toEqual({ input: task })
  for (const [field, value] of [
    ['key', null],
    ['title', 1],
    ['parent_id', 'not-a-uuid'],
    ['opened_at', 'yesterday'],
    ['source', 'unknown'],
    ['next_document_number', 0],
  ] as const) {
    const parsed = parseHostedPushItem({ ...task, row: { ...task.row, [field]: value } })
    expect('outcome' in parsed ? parsed.outcome.reason : null).toContain(`row.${field}`)
  }
})
