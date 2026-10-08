import { newRecordId } from '../../shared/record/schema.ts'
import { db, writeTransaction } from './db.ts'
import { isTaskMirrorAdoption, type MirrorAdoption } from './hosted-tasks.ts'
import { rememberHostedInstall } from './install-binding.ts'
import { projects } from './projects.ts'
import type { TaskRow } from './task.ts'
import { persistTaskAdoptionsOn } from './task-adoption.ts'
import {
  assertTargetSpaceTaskMirror,
  hostedMirrorTasks,
  hostedTaskCounts,
  hostedTaskIdentity,
  type TaskFetch,
} from './task-client.ts'
import { resolveTask } from './task-identity.ts'
import {
  issueForDestination,
  type PushCollections,
  planTaskPush,
  type TaskPushDestination,
} from './task-push-plan.ts'

type Options = { dryRun?: boolean; baseUrl?: string; token?: string | null; fetch?: TaskFetch }
type ChildRow = {
  id: number
  record_id: string | null
  task_key: string
  task_record_id: string | null
  [key: string]: unknown
}
type MirroredChild = {
  id: string
  record_id: string | null
  task_key: string
  task_id: string | null
  legacy_local_id: number
  newly_assigned: boolean
  project_name: string
  deleted_at: null
  [key: string]: unknown
}
const grouped = (rows: Array<{ source: string; count: number }>) =>
  Object.fromEntries(rows.map((row) => [row.source, row.count]))

function sourceCounts<T>(values: T[], source: (row: T) => string | undefined) {
  const counts = new Map<string, number>()
  for (const row of values) {
    const value = source(row)
    if (value) counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return Object.fromEntries([...counts].sort(([a], [b]) => a.localeCompare(b)))
}

function localCounts(rows: PushCollections) {
  const taskByKey = new Map(rows.tasks.map((row) => [row.key, row]))
  return {
    task: sourceCounts(rows.tasks, (row) => row.source),
    task_comment: sourceCounts(rows.comments, (row) => taskByKey.get(row.task_key)?.source),
    task_document: sourceCounts(rows.documents, (row) => taskByKey.get(row.task_key)?.source),
    task_status_event: sourceCounts(
      rows.statusEvents,
      (row) => taskByKey.get(row.task_key)?.source,
    ),
  }
}

function sequenceRaises(tasks: PushCollections['tasks']) {
  const maxima = new Map<string, { project: string; prefix: string; next: number }>()
  for (const task of tasks) {
    const match = /^([A-Z][A-Z0-9]*)-(\d+)$/.exec(task.key)
    if (!match) continue
    const old = maxima.get(match[1]!)
    const next = Number(match[2]) + 1
    if (!old || next > old.next)
      maxima.set(match[1]!, { project: task.project, prefix: match[1]!, next })
  }
  return [...maxima.values()]
}

async function deliverDestination(
  destination: TaskPushDestination,
  requestOptions: { baseUrl?: string; token?: string | null; fetch?: TaskFetch },
) {
  for (const [name, rows] of Object.entries(destination.rows))
    for (let index = 0; index < rows.length; index += 500) {
      const batch = rows.slice(index, index + 500)
      const response = await hostedMirrorTasks(
        { tasks: name === 'tasks' ? batch : [], [name]: batch, targetSpaceId: destination.spaceId },
        requestOptions,
      )
      persistMirrorBatch(name as keyof PushCollections, batch, response.adoptions ?? [])
    }
  await hostedMirrorTasks(
    {
      tasks: [],
      raiseSequences: sequenceRaises(destination.rows.tasks),
      targetSpaceId: destination.spaceId,
    },
    requestOptions,
  )
}

function persistMirrorBatch(
  name: keyof PushCollections,
  rows: Array<Record<string, unknown>>,
  adoptions: MirrorAdoption[],
) {
  const taskAdoptions = adoptions.filter(isTaskMirrorAdoption)
  const childAdoptions = adoptions.filter(
    (adoption): adoption is Exclude<MirrorAdoption, { table: 'task' }> =>
      !isTaskMirrorAdoption(adoption),
  )
  const newlyAssigned = rows.filter((row) => row.newly_assigned === true)
  if (!newlyAssigned.length && !adoptions.length) return
  writeTransaction((conn) => {
    persistTaskAdoptionsOn(conn, taskAdoptions)
    if (name === 'tasks') {
      const update = conn.query(`UPDATE task SET record_id=? WHERE record_id=?`)
      const adopted = new Set(
        taskAdoptions.map((adoption) => `${adoption.project}\0${adoption.key}`),
      )
      for (const row of newlyAssigned) {
        const id = row.id as string
        const key = row.key as string
        const project = row.project as string
        if (adopted.has(`${project}\0${key}`)) continue
        const previousRecordId = resolveTask(conn, key, project)
        update.run(id, previousRecordId)
      }
    } else {
      const table = {
        comments: 'task_comment',
        documents: 'task_document',
        statusEvents: 'task_status_event',
      }[name]
      const update = conn.query(`UPDATE ${table} SET record_id=? WHERE id=? AND record_id IS NULL`)
      for (const row of newlyAssigned) update.run(row.id as string, row.legacy_local_id as number)
    }
    for (const adoption of childAdoptions)
      conn
        .query(`UPDATE ${adoption.table} SET record_id=? WHERE id=?`)
        .run(adoption.id, adoption.legacy_local_id)
  })
}

export async function pushTasks(options: Options = {}) {
  const taskRows = db().query<TaskRow, []>(`SELECT * FROM task ORDER BY key`).all()
  const tasks = taskRows.map((row) => ({
    id: row.record_id ?? newRecordId(),
    newly_assigned: row.record_id === null,
    key: row.key,
    project: row.project,
    project_name: row.project,
    title: row.title,
    status: row.status,
    status_category: row.status_category,
    parent_key: row.parent_key,
    parent_id: row.parent_record_id,
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
  const taskByRecordId = new Map(tasks.map((row) => [row.id, row]))
  const child = (table: string): MirroredChild[] => {
    const rows = db().query<ChildRow, []>(`SELECT * FROM ${table} ORDER BY id`).all()
    return rows.map((row) => {
      const { task_record_id: taskId, ...hosted } = row
      return {
        ...hosted,
        id: row.record_id ?? newRecordId(),
        record_id: row.record_id,
        task_id: taskId,
        legacy_local_id: row.id,
        newly_assigned: row.record_id === null,
        project_name:
          (taskId ? taskByRecordId.get(taskId) : undefined)?.project_name ??
          taskByKey.get(row.task_key)?.project_name ??
          '',
        deleted_at: null,
      }
    })
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
  assertTargetSpaceTaskMirror(identity)
  rememberHostedInstall(identity.activeSpaceId)
  const plan = planTaskPush({ tasks, comments, documents, statusEvents }, projects(), identity)
  const assignedRecordIds = plan.destinations.reduce(
    (total, destination) =>
      total +
      Object.values(destination.rows).reduce(
        (count, rows) => count + rows.filter((row) => row.newly_assigned === true).length,
        0,
      ),
    0,
  )
  const local = Object.fromEntries(
    plan.destinations.map((destination) => [destination.spaceId, localCounts(destination.rows)]),
  )
  if (options.dryRun)
    return { local, skipped: plan.refused, assignedRecordIds, hosted: null, match: null }
  const skipped = [...plan.refused]
  const hosted: Record<string, Record<string, Record<string, number>>> = {}
  for (const destination of plan.destinations) {
    try {
      await deliverDestination(destination, requestOptions)
      const hostedRows = await hostedTaskCounts(destination.spaceId, requestOptions)
      hosted[destination.spaceId] = Object.fromEntries(
        Object.entries(hostedRows).map(([table, rows]) => [table, grouped(rows)]),
      )
    } catch (error) {
      skipped.push(
        ...issueForDestination(destination, `delivery-failed: ${(error as Error).message}`),
      )
    }
  }
  const match =
    skipped.length === 0 &&
    plan.destinations.every(
      (destination) =>
        JSON.stringify(local[destination.spaceId]) === JSON.stringify(hosted[destination.spaceId]),
    )
  return { local, skipped, assignedRecordIds, hosted, match }
}
