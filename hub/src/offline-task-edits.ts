import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { isDatabaseLocked } from '../../shared/database-lock-refusal.ts'
import { db } from './db.ts'
import {
  drainHostedOutbox,
  type HostedRoutingWait,
  hostedRoutingWaitForEntries,
  type OutboxEntry,
  parseHostedRoutingWait,
  queueHostedChange,
} from './outbox.ts'
import { projectRecordIdFor } from './project-record-id.ts'
import { HOSTED_DOCUMENT_TABLE } from './push-contract.ts'
import { hostedPushChanges, hostedTaskIdentity } from './task-client.ts'
import type { HostedTaskWriteOptions } from './task-write-destination.ts'

export type HostedEditDelivery =
  | { kind: 'sent' }
  | { kind: 'queued'; reason: string }
  | { kind: 'rejected'; reason: string }

export function applyHostedWriteLocally(
  reference: string,
  action: 'created' | 'updated',
  apply: () => void,
): boolean {
  try {
    apply()
    return true
  } catch (error) {
    if (!isDatabaseLocked(error)) throw error
    console.error(
      `${reference} was ${action} in the hosted record; its local copy will arrive on the next record pull`,
    )
    return false
  }
}

function classifyHostedEditDelivery(
  remaining: OutboxEntry[],
  report: Awaited<ReturnType<typeof drainHostedOutbox>>,
  leaseRoutingWait: HostedRoutingWait | null,
): HostedEditDelivery {
  const waitingOnRouting = remaining
    .map((entry) => parseHostedRoutingWait(entry.last_error))
    .find((wait) => wait !== null)
  const refused = remaining.find(
    (entry) => entry.last_error && !parseHostedRoutingWait(entry.last_error),
  )
  if (refused) return { kind: 'rejected', reason: refused.last_error! }
  if (!remaining.length && report.hostedReachable && !report.skippedCapability)
    return { kind: 'sent' }
  if (waitingOnRouting) return { kind: 'queued', reason: waitingOnRouting.message }
  if (leaseRoutingWait) return { kind: 'queued', reason: leaseRoutingWait.message }
  if (report.lockAcquired === false)
    return {
      kind: 'queued',
      reason: 'another process is draining; the collector fast cycle will send it',
    }
  return {
    kind: 'queued',
    reason: report.skippedCapability
      ? 'the hosted session is absent or cannot push these rows'
      : 'the hosted hub could not be reached',
  }
}

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
    const leaseRoutingWait =
      report.lockAcquired === false
        ? await hostedRoutingWaitForEntries(remaining, {
            identity: () => hostedTaskIdentity(options),
          })
        : null
    const result = classifyHostedEditDelivery(remaining, report, leaseRoutingWait)
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
