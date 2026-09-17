import { newRecordId } from '../../shared/record/schema.ts'
import { db } from './db.ts'
import type { TaskRow } from './task.ts'
import { hostedMirrorTasks, hostedTaskCounts, type TaskFetch } from './task-client.ts'

type Options = { dryRun?: boolean; baseUrl?: string; token?: string | null; fetch?: TaskFetch }
type ChildRow = { id: number; record_id: string | null; task_key: string } & Record<string, unknown>
type MirroredChild = Omit<ChildRow, 'id'> & {
  id: string
  legacy_local_id: number
  project_name: string
  deleted_at: null
}
type CountRow = { source: string; count: number }
const grouped = (rows: Array<{ source: string; count: number }>) =>
  Object.fromEntries(rows.map((row) => [row.source, row.count]))

export async function pushTasks(options: Options = {}) {
  const tasks = db()
    .query<TaskRow, []>(`SELECT * FROM task ORDER BY key`)
    .all()
    .map((row) => ({
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
  const child = (table: string): MirroredChild[] =>
    db()
      .query<ChildRow, []>(`SELECT * FROM ${table} ORDER BY id`)
      .all()
      .map((row) => ({
        ...row,
        id: row.record_id ?? newRecordId(),
        legacy_local_id: row.id,
        project_name: taskByKey.get(row.task_key)?.project_name ?? '',
        deleted_at: null,
      }))
  const comments = child('task_comment').map((row) => ({
    ...row,
    updated_at: row['created_at'],
  }))
  const documents = child('task_document')
  const statusEvents = child('task_status_event').map((row) => ({
    ...row,
    created_at: row['at'],
    updated_at: row['at'],
  }))
  const local = {
    task: grouped(
      db()
        .query<CountRow, []>(
          `SELECT source,count(*) count FROM task GROUP BY source ORDER BY source`,
        )
        .all(),
    ),
    task_comment: grouped(
      db()
        .query<CountRow, []>(
          `SELECT t.source,count(*) count FROM task_comment c JOIN task t ON t.key=c.task_key GROUP BY t.source ORDER BY t.source`,
        )
        .all(),
    ),
    task_document: grouped(
      db()
        .query<CountRow, []>(
          `SELECT t.source,count(*) count FROM task_document d JOIN task t ON t.key=d.task_key GROUP BY t.source ORDER BY t.source`,
        )
        .all(),
    ),
    task_status_event: grouped(
      db()
        .query<CountRow, []>(
          `SELECT t.source,count(*) count FROM task_status_event e JOIN task t ON t.key=e.task_key GROUP BY t.source ORDER BY t.source`,
        )
        .all(),
    ),
  }
  if (options.dryRun) return { local, hosted: null, match: null }
  const requestOptions = { baseUrl: options.baseUrl, token: options.token, fetch: options.fetch }
  for (const [name, rows] of Object.entries({ tasks, comments, documents, statusEvents }))
    for (let index = 0; index < rows.length; index += 500)
      await hostedMirrorTasks(
        {
          tasks: name === 'tasks' ? rows.slice(index, index + 500) : [],
          [name]: rows.slice(index, index + 500),
        },
        requestOptions,
      )
  const maxima = new Map<string, { project: string; prefix: string; next: number }>()
  for (const task of tasks) {
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
  return { local, hosted, match }
}
