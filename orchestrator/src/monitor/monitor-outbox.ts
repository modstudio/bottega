// concern: monitor-outbox
/** Reports recoverable hosted-record outbox quarantine state. */
import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { blockedByRetiredParentRows } from '../record/outbox-dependency.ts'
import { heldOutboxKinds } from '../record/outbox-held.ts'
import { quarantinedOutboxRows } from '../record/outbox-quarantine.ts'
import type { AddressedMonitorCondition } from './monitor-types.ts'
export function outboxQuarantineConditions(database: Database): AddressedMonitorCondition[] {
  return quarantinedOutboxRows(database).map((row) => ({
    kind: 'outbox-quarantined',
    subject: `outbox:${row.id}`,
    since: row.quarantinedAt,
    ageMs: null,
    detail: `${row.kind} outbox row ${row.id} is quarantined: ${row.error}`,
    action: `run ${PLATFORM_SLUG} record outbox retry orch:${row.id}, or retire it with an audited reason`,
    ownerSession: null,
  }))
}

export function outboxRetiredParentConditions(database: Database): AddressedMonitorCondition[] {
  return blockedByRetiredParentRows(database).map((row) => ({
    kind: 'outbox-retired-parent',
    subject: `outbox:${row.id}`,
    since: null,
    ageMs: null,
    detail: `${row.kind} outbox row ${row.id} is blocked by ${row.reason ?? `retired parent ${row.parentRecordId}`}`,
    action: `inspect the parent retirement, then run ${PLATFORM_SLUG} record outbox retire orch:${row.id} --reason <text> or replace the dependent row`,
    ownerSession: null,
  }))
}

export function outboxHeldForUpgradeConditions(
  database: Database,
  clock: number = Date.now(),
): AddressedMonitorCondition[] {
  return heldOutboxKinds(database).map((row) => {
    const ageMs = Math.max(0, clock - new Date(row.oldestCreatedAt).getTime())
    return {
      kind: 'outbox-held-for-upgrade',
      subject: `outbox-kind:${row.kind}`,
      since: row.oldestCreatedAt,
      ageMs,
      detail: `${row.count} ${row.kind} outbox row(s) held; oldest age ${Math.round(ageMs / 60_000)}m; ${row.reason}`,
      action: `run ${PLATFORM_SLUG} release run ${PLATFORM_SLUG} --rung hosted-api`,
      ownerSession: null,
    }
  })
}

export function outboxConditions(database: Database, clock: number): AddressedMonitorCondition[] {
  return [
    ...outboxQuarantineConditions(database),
    ...outboxHeldForUpgradeConditions(database, clock),
    ...outboxRetiredParentConditions(database),
  ]
}
