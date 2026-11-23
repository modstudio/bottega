import { describe, expect, spyOn, test } from 'bun:test'
import type { HostedTask } from './hosted-tasks.ts'
import { projectList } from './orch-project-register.ts'
import { installProjectRegisterReader } from './project-register-reader.ts'
import { refreshProjects } from './projects.ts'
import { hostedTaskBatch, hostedTaskRow } from './task-hosted-record.ts'
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

test('a raw hosted task row keeps its database project id without reading the register', () => {
  const spawn = spyOn(Bun, 'spawnSync')
  const hosted: HostedTask = {
    id: current.record_id,
    key: current.key,
    project: 'absent-from-register',
    project_name: 'absent-from-register',
    project_id: '01990000-0000-7000-8000-000000002613',
    title: current.title,
    status: current.status,
    status_category: current.status_category,
    parent_key: current.parent_key,
    parent_id: current.parent_record_id,
    body: current.body,
    assignee: current.assignee,
    opened_at: current.opened_at,
    closed_at: current.closed_at,
    source: current.source,
    first_seen: current.first_seen,
    last_seen: current.last_seen,
    created_at: current.first_seen,
    updated_at: current.updated_at,
    deleted_at: null,
    next_document_number: current.next_document_number,
    retired_reason: current.retired_reason,
    revision: current.revision,
  }
  try {
    installProjectRegisterReader(() => [])
    refreshProjects()

    expect(hostedTaskRow(hosted).project_record_id).toBe(hosted.project_id)
    expect(spawn).not.toHaveBeenCalled()
  } finally {
    installProjectRegisterReader(projectList)
    refreshProjects()
    spawn.mockRestore()
  }
})

describe('hosted task patch payload', () => {
  test('carries the command read values only for patched scalar fields', () => {
    const stages = hostedTaskBatch({
      current,
      changes: { status: 'active', parent: null, assignee: 'Lee' },
      category: 'active',
      at: '2026-11-20T01:00:00.000Z',
      attribution: { actorUserId: null, actorName: null, agent: null, runId: null },
    })
    const change = stages[0]![0]!

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
    const stages = hostedTaskBatch({
      current,
      changes: { title: 'After', body: 'Next body' },
      category: 'open',
      at: '2026-11-20T01:00:00.000Z',
      attribution: { actorUserId: null, actorName: null, agent: null, runId: null },
      expectedRevision: 7,
    })
    const change = stages[0]![0]!

    expect(change).toMatchObject({
      fields: ['title', 'body'],
      expected_revision: 7,
    })
    expect(change).not.toHaveProperty('from')
  })

  test('closing an already-done task sends no status event', () => {
    const done = { ...current, status: 'done', status_category: 'done' as const }
    const changes = hostedTaskBatch({
      current: done,
      changes: { status: 'done' },
      category: 'done',
      at: '2026-11-20T01:00:00.000Z',
      attribution: { actorUserId: null, actorName: null, agent: null, runId: null },
    })

    expect(changes).toHaveLength(1)
    expect(changes[0]?.[0]).toMatchObject({ table: 'hub_task' })
  })
})
