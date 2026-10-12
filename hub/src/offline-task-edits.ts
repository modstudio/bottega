import type { Database } from 'bun:sqlite'
import { drainHostedOutbox, queueHostedChange } from './outbox.ts'
import { HOSTED_DOCUMENT_TABLE } from './push-contract.ts'
import { hostedPushChanges, hostedTaskIdentity } from './task-client.ts'
import type { HostedTaskWriteOptions } from './task-write-destination.ts'

export async function drainHostedEditOutbox(options?: HostedTaskWriteOptions) {
  try {
    await drainHostedOutbox({
      identity: () => hostedTaskIdentity(options),
      push: (changes, destination) =>
        hostedPushChanges(changes, { ...options, recordSpace: destination.recordSpace }),
    })
  } catch {
    /* the durable queue is the offline result */
  }
}

export function queueHostedDocumentUpsert(
  conn: Database,
  id: string,
  at: string,
  fields: readonly string[],
) {
  queueHostedChange(conn, HOSTED_DOCUMENT_TABLE, id, 'upsert', at, fields)
}

export function queueHostedDocumentDelete(conn: Database, id: string, project: string) {
  queueHostedChange(conn, HOSTED_DOCUMENT_TABLE, id, 'delete')
  conn
    .query(`UPDATE hosted_outbox SET routing_project=? WHERE table_name=? AND row_id=?`)
    .run(project, HOSTED_DOCUMENT_TABLE, id)
}
