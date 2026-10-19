import type { HostedChangeFamily } from './hosted-change-family.ts'
import type { HostedSend } from './hosted-reports.ts'
import { cacheHostedSend } from './report-cache.ts'
import { hostedSendChanges } from './report-client.ts'
import type { RegisteredTaskSpace, TaskDestinationIdentity } from './task-project-space.ts'

export const HOSTED_SEND_CHANGES_CURSOR_KEY = 'collect.hosted-send-changes.cursor'

export function createHostedSendChangeFamily(
  _registered: readonly RegisteredTaskSpace[],
  identity: TaskDestinationIdentity,
): HostedChangeFamily {
  const activeSpaceId = identity.activeSpaceId
  return {
    cursorPrefix: HOSTED_SEND_CHANGES_CURSOR_KEY,
    tables: 'hub_send',
    spaces: () => [activeSpaceId],
    fullPull: async (cursor, options) => {
      const page = await hostedSendChanges(cursor, options)
      if (page.more && page.cursor === null)
        throw new Error('hosted send full read did not advance; the hosted route cannot page')
      return {
        cursor: page.cursor ?? cursor ?? '',
        more: page.more,
        apply: (conn) => {
          for (const row of page.sends) cacheHostedSend(conn, row)
        },
      }
    },
    tableOrder: () => 0,
    accepts: (table) => table === 'hub_send',
    machineRow: (conn, _table, id) =>
      conn
        .query<Record<string, unknown>, [string]>('SELECT * FROM send WHERE record_id=?')
        .get(id) ?? null,
    rowSpace: (conn, _table, id) =>
      conn.query('SELECT 1 FROM send WHERE record_id=?').get(id) ? activeSpaceId : null,
    apply: (conn, _table, row) => cacheHostedSend(conn, row as HostedSend),
    delete: (conn, _table, id) => conn.query('DELETE FROM send WHERE record_id=?').run(id),
    failureLabel: 'hosted send change',
  }
}
