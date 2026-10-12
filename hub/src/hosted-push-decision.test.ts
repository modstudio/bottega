import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { DELETED_ON_HOSTED_RECORD_REASON } from './hosted-delete.ts'
import { decideDocumentUpsert, decideTaskUpsert } from './hosted-push-decision.ts'
import type { PushedDocument, PushedTask } from './push-contract.ts'

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
