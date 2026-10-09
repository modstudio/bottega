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
import { hostedTaskChanges } from './task-client.ts'
import {
  type RegisteredTaskSpace,
  type TaskDestinationIdentity,
  taskProjectDestination,
  taskPullSpaces,
} from './task-project-space.ts'

export const HOSTED_CHANGES_CURSOR_KEY = 'collect.hosted-changes.cursor'

export function createHostedTaskChangeFamily(
  registered: readonly RegisteredTaskSpace[],
  identity: TaskDestinationIdentity,
): HostedChangeFamily {
  return {
    cursorPrefix: HOSTED_CHANGES_CURSOR_KEY,
    tables: HOSTED_TASK_CHANGE_TABLE_QUERY,
    spaces: taskPullSpaces,
    fullPull: async (options) => {
      const snapshot = await hostedTaskChanges(null, options)
      return (conn) => applyHostedTaskRows(conn, snapshot)
    },
    tableOrder: () => 0,
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
    failureLabel: 'hosted task change',
  }
}
