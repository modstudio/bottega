import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { DELETED_ON_HOSTED_RECORD_REASON } from './hosted-delete.ts'
import { decideHostedCommentPush } from './hosted-push-changes.ts'
import {
  decideDocumentUpsert,
  decideNoteAcknowledgementUpsert,
  decideNoteUpsert,
  decidePushGuards,
  decideTaskUpsert,
} from './hosted-push-decision.ts'
import type {
  ParsedHostedPushChange,
  PushedComment,
  PushedDocument,
  PushedNote,
  PushedNoteAcknowledgement,
  PushedTask,
} from './push-contract.ts'

const at = '2026-10-11T12:00:00.000Z'
const later = '2026-10-11T13:00:00.000Z'
const task: PushedTask = {
  id: Bun.randomUUIDv7(),
  key: 'DEV-1',
  project: PLATFORM_SLUG,
  project_name: PLATFORM_SLUG,
  title: 'stored',
  status: 'open',
  status_category: 'open',
  parent_key: null,
  parent_id: null,
  body: null,
  assignee: null,
  opened_at: at,
  closed_at: null,
  source: 'local',
  first_seen: at,
  last_seen: later,
  created_at: at,
  updated_at: later,
  deleted_at: null,
  next_document_number: 1,
}

test('a stored driver Date keeps its milliseconds when the later time is chosen', () => {
  const stored = { ...task, updated_at: new Date('2026-10-11T13:00:00.207Z') as unknown as string }
  expect(
    decideTaskUpsert(
      stored,
      { ...task, title: 'renamed', updated_at: '2026-10-11T13:00:00.100Z' },
      ['title'],
    ),
  ).toMatchObject({ kind: 'patch', values: { updated_at: '2026-10-11T13:00:00.207Z' } })
})

test('task field decisions ignore incoming time for duplicates and never move time backwards', () => {
  expect(decideTaskUpsert(task, { ...task, updated_at: at, last_seen: at }, ['status'])).toEqual({
    kind: 'duplicate',
  })
  expect(
    decideTaskUpsert(task, { ...task, status: 'done', status_category: 'done', updated_at: at }, [
      'status',
      'status_category',
    ]),
  ).toMatchObject({
    kind: 'patch',
    values: {
      status: 'done',
      status_category: 'done',
      updated_at: later,
      last_seen: later,
      closed_at: at,
    },
  })
  expect(decideTaskUpsert({ ...task, deleted_at: later }, task, ['title'])).toEqual({
    kind: 'reject',
    reason: DELETED_ON_HOSTED_RECORD_REASON,
  })
  expect(decideTaskUpsert(null, task, [])).toEqual({ kind: 'insert', row: task })
  expect(decideTaskUpsert(task, { ...task, title: 'other' }, [])).toEqual({ kind: 'duplicate' })
})

test('legacy task replacement leaves a stored retirement reason while explicit null clears it', () => {
  const stored = { ...task, retired_reason: 'out of scope' }
  const { retired_reason: _retiredReason, ...legacy } = task
  expect(decideTaskUpsert(stored, legacy, null)).toEqual({ kind: 'duplicate' })
  expect(decideTaskUpsert(stored, { ...task, retired_reason: null }, null)).toEqual({
    kind: 'replace',
    row: { ...task, retired_reason: null },
  })
})

test('document field decisions are duplicate by listed fields and reject tombstones', () => {
  const document: PushedDocument = {
    id: Bun.randomUUIDv7(),
    number: 1,
    task_key: task.key,
    task_id: task.id,
    project_name: task.project,
    role: null,
    title: 'title',
    body: 'body',
    version: 'v1',
    created_at: at,
    updated_at: later,
    deleted_at: null,
  }
  expect(decideDocumentUpsert(document, { ...document, updated_at: at }, ['title'])).toEqual({
    kind: 'duplicate',
  })
  expect(decideDocumentUpsert({ ...document, deleted_at: later }, document, ['body'])).toEqual({
    kind: 'reject',
    reason: DELETED_ON_HOSTED_RECORD_REASON,
  })
  expect(decideDocumentUpsert(document, { ...document, title: 'other' }, [])).toEqual({
    kind: 'duplicate',
  })
})

test('note decisions compare last-seen timestamps as instants and never move them backwards', () => {
  const note: PushedNote = {
    id: Bun.randomUUIDv7(),
    number: 1,
    project: PLATFORM_SLUG,
    project_name: PLATFORM_SLUG,
    text: 'note',
    area: null,
    anchors: '[]',
    sightings: 0,
    created_at: at,
    last_seen_at: later,
    stale_at: null,
    stale_reason: null,
    promoted_task: null,
    promoted_task_id: null,
    updated_at: later,
    deleted_at: null,
  }
  expect(decideNoteUpsert(note, { ...note, last_seen_at: at }, ['last_seen_at'])).toEqual({
    kind: 'duplicate',
  })
  expect(
    decideNoteUpsert({ ...note, last_seen_at: new Date(later) as unknown as string }, note, [
      'last_seen_at',
    ]),
  ).toEqual({ kind: 'duplicate' })
})

test('acknowledgement decisions compare timestamps as instants and never move them backwards', () => {
  const acknowledgement: PushedNoteAcknowledgement = {
    id: Bun.randomUUIDv7(),
    note_id: Bun.randomUUIDv7(),
    project_name: PLATFORM_SLUG,
    session_id: 'session',
    acknowledged_at: later,
    sightings: 1,
    created_at: at,
    updated_at: later,
    deleted_at: null,
  }
  expect(
    decideNoteAcknowledgementUpsert(acknowledgement, {
      ...acknowledgement,
      acknowledged_at: at,
      updated_at: at,
    }),
  ).toEqual({ kind: 'duplicate' })
  expect(
    decideNoteAcknowledgementUpsert(
      {
        ...acknowledgement,
        acknowledged_at: new Date(later) as unknown as string,
      },
      acknowledgement,
    ),
  ).toEqual({ kind: 'duplicate' })
})

test('record timestamp spellings agree across guards, upserts, and comment matching', () => {
  const canonical = '2026-10-11T12:00:00.000Z'
  const equivalentForms = [
    canonical,
    '2026-10-11T12:00:00.000+00:00',
    '2026-10-11T12:00:00.000999Z',
    '2026-10-11T12:00:00Z',
  ] as const
  const canonicalTask = { ...task, updated_at: canonical }
  const document: PushedDocument = {
    id: Bun.randomUUIDv7(),
    number: 1,
    task_key: task.key,
    task_id: task.id,
    project_name: task.project,
    role: null,
    title: 'title',
    body: 'body',
    version: 'v1',
    created_at: canonical,
    updated_at: canonical,
    deleted_at: null,
  }
  const note: PushedNote = {
    id: Bun.randomUUIDv7(),
    number: 1,
    project: PLATFORM_SLUG,
    project_name: PLATFORM_SLUG,
    text: 'note',
    area: null,
    anchors: '[]',
    sightings: 0,
    created_at: canonical,
    last_seen_at: canonical,
    stale_at: null,
    stale_reason: null,
    promoted_task: null,
    promoted_task_id: null,
    updated_at: canonical,
    deleted_at: null,
  }
  const comment: PushedComment = {
    id: Bun.randomUUIDv7(),
    task_key: task.key,
    task_id: task.id,
    project_name: task.project,
    body: 'body',
    created_at: canonical,
    updated_at: canonical,
    deleted_at: null,
    actor_user_id: '01990000-0000-7000-8000-000000001249',
    actor_name: 'Person',
    agent: null,
    run_id: null,
  }

  for (const form of equivalentForms) {
    for (const storedValue of [form, new Date(form)] as const) {
      const storedTimestamp = storedValue as unknown as string
      expect(
        decidePushGuards(
          { ...task, table: 'hub_task', op: 'upsert', row: task, from: { updated_at: canonical } },
          { ...task, updated_at: storedValue } as object,
        ).kind,
      ).toBe('ok')
      expect(
        decidePushGuards(
          { ...task, table: 'hub_task', op: 'upsert', row: task, from: { opened_at: canonical } },
          { ...task, opened_at: storedValue } as object,
        ).kind,
      ).toBe('ok')
      expect(
        decideTaskUpsert({ ...task, updated_at: storedTimestamp }, canonicalTask, null).kind,
      ).toBe('duplicate')
      expect(
        decideTaskUpsert({ ...task, updated_at: storedTimestamp }, canonicalTask, ['updated_at'])
          .kind,
      ).toBe('duplicate')
      expect(
        decideDocumentUpsert({ ...document, updated_at: storedTimestamp }, document, null).kind,
      ).toBe('duplicate')
      expect(
        decideDocumentUpsert({ ...document, updated_at: storedTimestamp }, document, ['updated_at'])
          .kind,
      ).toBe('duplicate')
      expect(
        decideNoteUpsert({ ...note, last_seen_at: storedTimestamp }, note, ['last_seen_at']).kind,
      ).toBe('duplicate')
      expect(
        decideHostedCommentPush(
          { ...comment, actor_user_id: comment.actor_user_id!, updated_at: storedTimestamp },
          comment,
          comment.actor_user_id!,
        ).kind,
      ).toBe('duplicate')
    }
  }

  const different = '2026-10-11T11:59:59.999Z'
  expect(
    decidePushGuards(
      { ...task, table: 'hub_task', op: 'upsert', row: task, from: { updated_at: canonical } },
      { ...task, updated_at: different } as object,
    ).kind,
  ).toBe('field-conflict')
  expect(
    decidePushGuards(
      { ...task, table: 'hub_task', op: 'upsert', row: task, from: { opened_at: canonical } },
      { ...task, opened_at: different } as object,
    ).kind,
  ).toBe('field-conflict')
  expect(decideTaskUpsert({ ...task, updated_at: different }, canonicalTask, null).kind).toBe(
    'replace',
  )
  expect(
    decideTaskUpsert({ ...task, updated_at: different }, canonicalTask, ['updated_at']).kind,
  ).toBe('patch')
  expect(decideDocumentUpsert({ ...document, updated_at: different }, document, null).kind).toBe(
    'replace',
  )
  expect(
    decideDocumentUpsert({ ...document, updated_at: different }, document, ['updated_at']).kind,
  ).toBe('patch')
  expect(decideNoteUpsert({ ...note, last_seen_at: different }, note, ['last_seen_at']).kind).toBe(
    'patch',
  )
  expect(
    decideHostedCommentPush(
      { ...comment, actor_user_id: comment.actor_user_id!, updated_at: different },
      comment,
      comment.actor_user_id!,
    ).kind,
  ).toBe('apply')
  expect(
    decideNoteUpsert(
      { ...note, last_seen_at: '2026-10-11T12:00:00.500Z' },
      { ...note, last_seen_at: '2026-10-11T12:00:01+00:00' },
      ['last_seen_at'],
    ),
  ).toMatchObject({
    kind: 'patch',
    values: { last_seen_at: '2026-10-11T12:00:01.000Z' },
  })
})

test('an invalid timestamp guard returns a field conflict', () => {
  expect(
    decidePushGuards(
      {
        table: 'hub_task',
        op: 'upsert',
        row: { key: 'DEV-1' },
        from: { updated_at: 'garbage' },
      } as ParsedHostedPushChange,
      { updated_at: '2026-10-11T12:00:00.000Z' },
    ),
  ).toMatchObject({ kind: 'field-conflict', field: 'updated_at', key: 'DEV-1' })
})
