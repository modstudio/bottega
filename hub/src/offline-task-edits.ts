import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { db } from './db.ts'
import { drainHostedOutbox, type OutboxEntry, queueHostedChange } from './outbox.ts'
import { projectRecordIdFor } from './project-record-id.ts'
import { HOSTED_DOCUMENT_TABLE } from './push-contract.ts'
import { hostedPushChanges, hostedTaskIdentity } from './task-client.ts'
import type { HostedTaskWriteOptions } from './task-write-destination.ts'

export type HostedEditDelivery =
  | { kind: 'sent' }
  | { kind: 'queued'; reason: string }
  | { kind: 'rejected'; reason: string }

export async function drainHostedEditOutbox(
  queuedAt: string,
  options?: HostedTaskWriteOptions,
): Promise<HostedEditDelivery> {
  try {
    const report = await drainHostedOutbox({
      identity: () => hostedTaskIdentity(options),
      push: (changes, destination) =>
        hostedPushChanges(changes, { ...options, recordSpace: destination.recordSpace }),
    })
    const remaining = db()
      .query<OutboxEntry, [string]>(`SELECT * FROM hosted_outbox WHERE queued_at=?`)
      .all(queuedAt)
    const refused = remaining.find((entry) => entry.last_error)
    const result: HostedEditDelivery = refused
      ? { kind: 'rejected', reason: refused.last_error! }
      : remaining.length || !report.hostedReachable || report.skippedCapability
        ? {
            kind: 'queued',
            reason:
              report.lockAcquired === false
                ? 'another process is draining; the collector fast cycle will send it'
                : report.skippedCapability
                  ? 'the hosted session is absent or cannot push these rows'
                  : 'the hosted hub could not be reached',
          }
        : { kind: 'sent' }
    reportHostedEditDelivery(result)
    return result
  } catch (error) {
    const result = {
      kind: 'queued' as const,
      reason: (error as Error).message || 'the hosted session is absent',
    }
    reportHostedEditDelivery(result)
    return result
  }
}

function reportHostedEditDelivery(result: HostedEditDelivery): void {
  if (result.kind === 'sent') console.error('hosted change sent')
  else if (result.kind === 'rejected')
    console.error(
      `hosted change rejected: ${result.reason}; inspect it with \`${PLATFORM_SLUG} record outbox\``,
    )
  else
    console.error(
      `hosted change saved and queued: ${result.reason}; inspect it with \`${PLATFORM_SLUG} record outbox\``,
    )
}

export function queueHostedDocumentUpsert(
  conn: Database,
  id: string,
  at: string,
  fields: readonly string[],
) {
  queueHostedChange(conn, HOSTED_DOCUMENT_TABLE, id, 'upsert', at, fields)
}

export function queueHostedDocumentDelete(conn: Database, id: string, project: string, at: string) {
  queueHostedChange(conn, HOSTED_DOCUMENT_TABLE, id, 'delete', at)
  conn
    .query(
      `UPDATE hosted_outbox SET routing_project=?, routing_project_record_id=? WHERE table_name=? AND row_id=?`,
    )
    .run(project, projectRecordIdFor(project), HOSTED_DOCUMENT_TABLE, id)
}
