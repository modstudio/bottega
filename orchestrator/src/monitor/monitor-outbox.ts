// concern: monitor-outbox
/** Reports recoverable hosted-record outbox quarantine state. */
import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { blockedByRetiredParentRows } from '../record/outbox-dependency.ts'
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
