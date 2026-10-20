import type { Database } from 'bun:sqlite'
import { db } from './db.ts'
import type { HostedChangeFamily } from './hosted-change-family.ts'
import {
  applyHostedChangeUpsert,
  applyHostedTaskRows,
  deleteHostedChangeRow,
  HOSTED_TASK_CHANGE_TABLE_QUERY,
  type HostedTaskChangeTable,
  hostedChangeMachineRow,
  hostedChangeRowProject,
  isHostedTaskChangeTable,
  reconcileParentRecordIds,
} from './task-cache.ts'
import {
  type HostedSpaceChange,
  type HostedSpaceChangePage,
  hostedGetTask,
  hostedTaskChanges,
  isMissingHostedTask,
} from './task-client.ts'
import {
  type RegisteredTaskSpace,
  type TaskDestinationIdentity,
  taskProjectDestination,
  taskPullSpaces,
} from './task-project-space.ts'

export const HOSTED_CHANGES_CURSOR_KEY = 'collect.hosted-changes.cursor'

const childTables = new Set(['hub_task_comment', 'hub_task_document', 'hub_task_status_event'])

type ChildRow = NonNullable<HostedSpaceChange['row']> & {
  task_id?: string | null
  task_key: string
  project_name: string
  deleted_at: string | null
}

function cachedParent(row: ChildRow) {
  if (row.task_id && db().query('SELECT 1 FROM task WHERE record_id=?').get(row.task_id))
    return true
  return Boolean(
    db().query('SELECT 1 FROM task WHERE key=? AND project=?').get(row.task_key, row.project_name),
  )
}

function pageParentStates(page: HostedSpaceChangePage) {
  const states = new Map<string, 'live' | 'absent'>()
  for (const change of page.changes) {
    if (change.table !== 'hub_task') continue
    const deleted =
      change.op === 'delete' || Boolean((change.row as { deleted_at?: string | null })?.deleted_at)
    states.set(change.id, deleted ? 'absent' : 'live')
  }
  return states
}

function liveChildRow(change: HostedSpaceChange): ChildRow | null {
  if (change.op !== 'upsert' || !childTables.has(change.table)) return null
  const row = change.row as ChildRow
  return row.deleted_at ? null : row
}

type ParentRequirement = { kind: 'ready' } | { kind: 'absent' } | { kind: 'fetch'; id: string }

function parentRequirement(
  row: ChildRow,
  pageParents: ReadonlyMap<string, 'live' | 'absent'>,
  fetched: ReadonlyMap<string, unknown>,
): ParentRequirement {
  if (cachedParent(row)) return { kind: 'ready' }
  if (!row.task_id || pageParents.get(row.task_id) === 'absent') return { kind: 'absent' }
  if (pageParents.get(row.task_id) === 'live' || fetched.has(row.task_id)) return { kind: 'ready' }
  return { kind: 'fetch', id: row.task_id }
}

async function fetchLiveParent(
  taskId: string,
  options: Parameters<NonNullable<HostedChangeFamily['preparePage']>>[1],
) {
  try {
    const task = (await hostedGetTask(taskId, options)).task
    return task.deleted_at ? null : task
  } catch (cause) {
    if (isMissingHostedTask(cause)) return null
    throw cause
  }
}

async function prepareTaskParents(
  page: HostedSpaceChangePage,
  options: Parameters<NonNullable<HostedChangeFamily['preparePage']>>[1],
) {
  const pageParents = pageParentStates(page)
  const fetched = new Map<string, Awaited<ReturnType<typeof hostedGetTask>>['task']>()
  const absent = new Set<string>()
  for (const change of page.changes) {
    const row = liveChildRow(change)
    if (!row) continue
    const requirement = parentRequirement(row, pageParents, fetched)
    if (requirement.kind === 'ready') continue
    if (requirement.kind === 'absent') {
      absent.add(`${change.table}:${change.id}`)
      continue
    }
    const parent = await fetchLiveParent(requirement.id, options)
    if (!parent) {
      pageParents.set(requirement.id, 'absent')
      absent.add(`${change.table}:${change.id}`)
    } else fetched.set(requirement.id, parent)
  }
  return {
    apply: [...fetched.values()].map(
      (task) => (conn: Database) =>
        applyHostedTaskRows(conn, {
          tasks: [task],
          comments: [],
          documents: [],
          statusEvents: [],
          cursor: '',
        }),
    ),
    skippedForAbsentParent: absent,
  }
}

export function createHostedTaskChangeFamily(
  registered: readonly RegisteredTaskSpace[],
  identity: TaskDestinationIdentity,
): HostedChangeFamily {
  return {
    cursorPrefix: HOSTED_CHANGES_CURSOR_KEY,
    tables: HOSTED_TASK_CHANGE_TABLE_QUERY,
    spaces: taskPullSpaces,
    fullPull: async (cursor, options) => {
      const snapshot = await hostedTaskChanges(cursor, options)
      return {
        cursor: snapshot.cursor,
        more: snapshot.more ?? false,
        apply: (conn) => applyHostedTaskRows(conn, snapshot),
      }
    },
    preparePage: prepareTaskParents,
    tableOrder: (table) => (table === 'hub_task' ? 0 : 1),
    accepts: isHostedTaskChangeTable,
    machineRow: (conn, table, id) =>
      hostedChangeMachineRow(conn, table as HostedTaskChangeTable, id),
    rowSpace: (conn, table, id) => {
      const project = hostedChangeRowProject(conn, table as HostedTaskChangeTable, id)
      if (project === null) return null
      const destination = taskProjectDestination(project, registered, identity)
      return 'destinationSpaceId' in destination ? destination.destinationSpaceId : null
    },
    apply: (conn, table, row) =>
      applyHostedChangeUpsert(conn, table as HostedTaskChangeTable, row as never),
    delete: (conn, table, id) => deleteHostedChangeRow(conn, table as HostedTaskChangeTable, id),
    finish: reconcileParentRecordIds,
    reportAbsentParentSkips: true,
    failureLabel: 'hosted task change',
  }
}
