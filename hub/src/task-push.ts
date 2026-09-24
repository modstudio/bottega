import { newRecordId } from '../../shared/record/schema.ts'
import { recordSpaceMembership } from '../../shared/record-space-membership.ts'
import { db, writeTransaction } from './db.ts'
import { projects } from './projects.ts'
import type { TaskRow } from './task.ts'
import {
  type HostedTaskIdentity,
  hostedMirrorTasks,
  hostedTaskCounts,
  hostedTaskIdentity,
  type TaskFetch,
} from './task-client.ts'

type Options = { dryRun?: boolean; baseUrl?: string; token?: string | null; fetch?: TaskFetch }
type ChildRow = {
  id: number
  record_id: string | null
  task_key: string
  [key: string]: unknown
}
type MirroredChild = {
  id: string
  record_id: string | null
  task_key: string
  legacy_local_id: number
  project_name: string
  deleted_at: null
  [key: string]: unknown
}
const grouped = (rows: Array<{ source: string; count: number }>) =>
  Object.fromEntries(rows.map((row) => [row.source, row.count]))

type PushCollections = {
  tasks: Array<
    Record<string, unknown> & {
      key: string
      project: string
      project_name: string
      source: string
    }
  >
  comments: Array<Record<string, unknown> & { task_key: string; project_name: string }>
  documents: Array<Record<string, unknown> & { task_key: string; project_name: string }>
  statusEvents: Array<Record<string, unknown> & { task_key: string; project_name: string }>
}
type RegisteredSpace = { name: string; settings: { space?: string } }
type SkipReason = 'unmapped' | 'different-space'

export function selectTaskPushRows(
  rows: PushCollections,
  registered: readonly RegisteredSpace[],
  identity: HostedTaskIdentity,
) {
  const registration = new Map(registered.map((project) => [project.name, project]))
  const reason = (projectName: string): SkipReason | null => {
    const project = registration.get(projectName)
    if (!project) return 'unmapped'
    const declared = project.settings.space
    if (!declared) return null
    const membership = recordSpaceMembership(declared, identity.memberships)
    if (!membership) return 'unmapped'
    return membership.spaceId === identity.activeSpaceId ? null : 'different-space'
  }
  const skipped = new Map<
    string,
    {
      project: string
      reason: SkipReason
      tasks: number
      comments: number
      documents: number
      statusEvents: number
    }
  >()
  const select = <T extends { project_name: string }>(name: keyof PushCollections, values: T[]) =>
    values.filter((row) => {
      const why = reason(row.project_name)
      if (!why) return true
      const entry = skipped.get(row.project_name) ?? {
        project: row.project_name,
        reason: why,
        tasks: 0,
        comments: 0,
        documents: 0,
        statusEvents: 0,
      }
      entry[name]++
      skipped.set(row.project_name, entry)
      return false
    })
  return {
    rows: {
      tasks: select('tasks', rows.tasks),
      comments: select('comments', rows.comments),
      documents: select('documents', rows.documents),
      statusEvents: select('statusEvents', rows.statusEvents),
    },
    skipped: [...skipped.values()].sort((a, b) => a.project.localeCompare(b.project)),
  }
}

function sourceCounts<T>(values: T[], source: (row: T) => string | undefined) {
  const counts = new Map<string, number>()
  for (const row of values) {
    const value = source(row)
    if (value) counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return Object.fromEntries([...counts].sort(([a], [b]) => a.localeCompare(b)))
}

export async function pushTasks(options: Options = {}) {
  const taskRows = db().query<TaskRow, []>(`SELECT * FROM task ORDER BY key`).all()
  const taskRecordIds = new Map(taskRows.map((row) => [row.key, row.record_id]))
  const tasks = taskRows.map((row) => ({
    id: row.record_id ?? newRecordId(),
    key: row.key,
    project: row.project,
    project_name: row.project,
    title: row.title,
    status: row.status,
    status_category: row.status_category,
    parent_key: row.parent_key,
    body: row.body,
    assignee: row.assignee,
    opened_at: row.opened_at,
    closed_at: row.closed_at,
    source: row.source,
    first_seen: row.first_seen,
    last_seen: row.last_seen,
    created_at: row.first_seen,
    updated_at: row.updated_at ?? row.last_seen,
    deleted_at: null,
  }))
  const taskByKey = new Map(tasks.map((row) => [row.key, row]))
  const childRecordIds = new Map<string, Map<number, string | null>>()
  const child = (table: string): MirroredChild[] => {
    const rows = db().query<ChildRow, []>(`SELECT * FROM ${table} ORDER BY id`).all()
    childRecordIds.set(table, new Map(rows.map((row) => [row.id, row.record_id])))
    return rows.map((row) => ({
      ...row,
      id: row.record_id ?? newRecordId(),
      legacy_local_id: row.id,
      project_name: taskByKey.get(row.task_key)?.project_name ?? '',
      deleted_at: null,
    }))
  }
  const comments = child('task_comment').map((row) => ({
    ...row,
    updated_at: row.created_at,
  }))
  const documents = child('task_document')
  const statusEvents = child('task_status_event').map((row) => ({
    ...row,
    created_at: row.at,
    updated_at: row.at,
  }))
  const requestOptions = { baseUrl: options.baseUrl, token: options.token, fetch: options.fetch }
  const identity = await hostedTaskIdentity(requestOptions)
  const selected = selectTaskPushRows(
    { tasks, comments, documents, statusEvents },
    projects(),
    identity,
  )
  const active = selected.rows
  const missingTaskIds = active.tasks.filter((row) => taskRecordIds.get(row.key) === null)
  const missingChildIds = (
    [
      ['task_comment', active.comments],
      ['task_document', active.documents],
      ['task_status_event', active.statusEvents],
    ] as const
  ).flatMap(([table, rows]) =>
    rows
      .filter((row) => childRecordIds.get(table)?.get(row.legacy_local_id as number) === null)
      .map((row) => ({ table, row })),
  )
  const assignedRecordIds = missingTaskIds.length + missingChildIds.length
  const selectedTaskByKey = new Map(active.tasks.map((row) => [row.key, row]))
  const local = {
    task: sourceCounts(active.tasks, (row) => row.source),
    task_comment: sourceCounts(
      active.comments,
      (row) => selectedTaskByKey.get(row.task_key)?.source,
    ),
    task_document: sourceCounts(
      active.documents,
      (row) => selectedTaskByKey.get(row.task_key)?.source,
    ),
    task_status_event: sourceCounts(
      active.statusEvents,
      (row) => selectedTaskByKey.get(row.task_key)?.source,
    ),
  }
  if (options.dryRun)
    return { local, skipped: selected.skipped, assignedRecordIds, hosted: null, match: null }
  if (assignedRecordIds)
    writeTransaction((conn) => {
      const taskUpdate = conn.query(`UPDATE task SET record_id=? WHERE key=?`)
      for (const row of missingTaskIds) taskUpdate.run(row.id as string, row.key)
      for (const { table, row } of missingChildIds)
        conn
          .query(`UPDATE ${table} SET record_id=? WHERE id=?`)
          .run(row.id as string, row.legacy_local_id as number)
    })
  for (const [name, rows] of Object.entries(active))
    for (let index = 0; index < rows.length; index += 500)
      await hostedMirrorTasks(
        {
          tasks: name === 'tasks' ? rows.slice(index, index + 500) : [],
          [name]: rows.slice(index, index + 500),
        },
        requestOptions,
      )
  const maxima = new Map<string, { project: string; prefix: string; next: number }>()
  for (const task of active.tasks) {
    const match = /^([A-Z][A-Z0-9]*)-(\d+)$/.exec(task.key)
    if (!match) continue
    const old = maxima.get(match[1]!)
    const next = Number(match[2]) + 1
    if (!old || next > old.next)
      maxima.set(match[1]!, { project: task.project, prefix: match[1]!, next })
  }
  await hostedMirrorTasks({ tasks: [], raiseSequences: [...maxima.values()] }, requestOptions)
  const hostedRows = await hostedTaskCounts(requestOptions)
  const hosted = Object.fromEntries(
    Object.entries(hostedRows).map(([table, rows]) => [table, grouped(rows)]),
  )
  const match = JSON.stringify(local) === JSON.stringify(hosted)
  return { local, skipped: selected.skipped, assignedRecordIds, hosted, match }
}
