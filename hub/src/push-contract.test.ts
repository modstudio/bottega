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
    ['status_category', 'waiting'],
    ['parent_id', 'not-a-uuid'],
    ['opened_at', 'yesterday'],
    ['source', 'unknown'],
    ['next_document_number', 0],
  ] as const) {
    const parsed = parseHostedPushItem({ ...task, row: { ...task.row, [field]: value } })
    expect('outcome' in parsed ? parsed.outcome.reason : null).toContain(`row.${field}`)
  }
})

test('field lists accept only the update vocabulary for their table', () => {
  expect(parseHostedPushItem({ ...task, fields: ['title', 'status', 'title'] })).toEqual({
    input: { ...task, fields: ['title', 'status'] },
  })
  expect(parseHostedPushItem({ ...task, fields: [] })).toEqual({
    input: { ...task, fields: [] },
  })
  for (const fields of [['created_at'], ['unknown'], 'title']) {
    const parsed = parseHostedPushItem({ ...task, fields })
    expect('outcome' in parsed ? parsed.outcome.reason : null).toContain('fields')
  }
})

test('comment and document rows validate every wire field', () => {
  const comment = {
    table: 'hub_task_comment',
    id,
    op: 'upsert',
    row: {
      id,
      task_key: 'DEV-30',
      task_id: id,
      project_name: PLATFORM_SLUG,
      body: 'body',
      created_at: at,
      updated_at: at,
      deleted_at: null,
      actor_user_id: null,
      actor_name: null,
      agent: null,
      run_id: null,
    },
  } satisfies HostedPushChange
  const document = {
    table: 'hub_task_document',
    id,
    op: 'upsert',
    row: { ...comment.row, number: 1, role: null, title: 'title', version: 'v1' },
  } satisfies HostedPushChange
  expect(parseHostedPushItem(comment)).toEqual({ input: comment })
  const { actor_user_id: _actorUserId, actor_name: _actorName, agent: _agent, run_id: _runId, ...legacyRow } = comment.row
  expect(parseHostedPushItem({ ...comment, row: legacyRow })).toEqual({ input: comment })
  expect(parseHostedPushItem(document)).toEqual({ input: document })
  for (const [value, field] of [
    [{ ...comment, row: { ...comment.row, task_id: 'bad' } }, 'task_id'],
    [{ ...comment, row: { ...comment.row, updated_at: 'bad' } }, 'updated_at'],
    [{ ...comment, row: { ...comment.row, deleted_at: false } }, 'deleted_at'],
    [{ ...document, row: { ...document.row, number: 0 } }, 'number'],
    [{ ...document, row: { ...document.row, role: 1 } }, 'role'],
    [{ ...document, row: { ...document.row, version: null } }, 'version'],
  ] as const) {
    const parsed = parseHostedPushItem(value)
    expect('outcome' in parsed ? parsed.outcome.reason : null).toContain(`row.${field}`)
  }
})

test('note edges require fields and reject unknown fields and malformed note-family rows', () => {
  const note = {
    table: 'hub_note',
    id,
    op: 'upsert',
    row: {
      id,
      number: 1,
      project: PLATFORM_SLUG,
      project_name: PLATFORM_SLUG,
      text: 'note',
      area: null,
      anchors: '[]',
      sightings: 0,
      created_at: at,
      last_seen_at: at,
      stale_at: null,
      stale_reason: null,
      promoted_task: null,
      promoted_task_id: null,
      updated_at: at,
      deleted_at: null,
    },
  }
  for (const value of [
    note,
    { ...note, fields: ['text'] },
    { ...note, fields: ['unknown'] },
    { ...note, fields: ['anchors'], row: { ...note.row, anchors: '{}' } },
  ]) {
    const parsed = parseHostedPushItem(value)
    expect('outcome' in parsed ? parsed.outcome.status : 'accepted').toBe('rejected')
  }
  const acknowledgement = {
    table: 'hub_note_acknowledgement',
    id,
    op: 'upsert',
    row: {
      id,
      note_id: 'not-a-uuid',
      project_name: PLATFORM_SLUG,
      session_id: 'session',
      acknowledged_at: at,
      sightings: 1,
      created_at: at,
      updated_at: at,
      deleted_at: null,
    },
  }
  const parsed = parseHostedPushItem(acknowledgement)
  expect('outcome' in parsed ? parsed.outcome.reason : '').toContain('row.note_id')
})
