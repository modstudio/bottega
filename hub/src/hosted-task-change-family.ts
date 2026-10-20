import type { Database } from 'bun:sqlite'
import { db } from './db.ts'
import type { HostedChangeFamily } from './hosted-change-family.ts'
import { hostedTaskReference } from './hosted-task-reference.ts'
import {
  applyHostedChangeUpsert,
  applyHostedTaskRows,
  childTaskRecordId,
  deleteHostedChangeRow,
  HOSTED_TASK_CHANGE_TABLE_QUERY,
  type HostedTaskChangeTable,
  hostedChangeMachineRow,
  hostedChangeRowProject,
  isHostedTaskChangeTable,
  isHostedTaskChildTable,
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

function liveChildRow(change: HostedSpaceChange) {
  if (change.op !== 'upsert' || !isHostedTaskChildTable(change.table) || !change.row) return null
  const row = change.row as Parameters<typeof childTaskRecordId>[1] & {
    deleted_at?: string | null
  }
  return row.deleted_at ? null : { table: change.table, row }
}

type ParentRequirement = { kind: 'ready' } | { kind: 'absent' } | { kind: 'fetch'; id: string }

function parentRequirement(
  child: NonNullable<ReturnType<typeof liveChildRow>>,
  pageParents: ReadonlyMap<string, 'live' | 'absent'>,
  fetched: ReadonlyMap<string, unknown>,
  cached: boolean,
): ParentRequirement {
  const parent = hostedTaskReference(child.table, child.row)
  if (parent.id && pageParents.get(parent.id) === 'absent') return { kind: 'absent' }
  if (parent.id && (pageParents.get(parent.id) === 'live' || fetched.has(parent.id)))
    return { kind: 'ready' }
  if (cached) return { kind: 'ready' }
  if (!parent.id) return { kind: 'absent' }
  return { kind: 'fetch', id: parent.id }
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
    const child = liveChildRow(change)
    if (!child) continue
    const cached = childTaskRecordId(db(), child.row) !== null
    const requirement = parentRequirement(child, pageParents, fetched, cached)
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
