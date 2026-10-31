// concern: monitor-outbox
/** Reports recoverable hosted-record outbox quarantine state. */
import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { blockedByRetiredParentRows, quarantinedParentHolds } from '../record/outbox-dependency.ts'
import { OUTBOX_ERROR_CAUSE_SEPARATOR } from '../record/outbox-failure.ts'
import { heldOutboxKinds } from '../record/outbox-held.ts'
import {
  HOSTED_API_RELEASE_COMMAND,
  outboxHeldUnknownColumns,
} from '../record/outbox-held-contract.ts'
import { quarantinedOutboxRows } from '../record/outbox-quarantine.ts'
import { type AddressedMonitorCondition, boundToChars } from './monitor-types.ts'

export const QUARANTINE_ERROR_SUMMARY_CHARS = 256

export function quarantineErrorSummary(error: string): string {
  const separatorIndex = error.lastIndexOf(OUTBOX_ERROR_CAUSE_SEPARATOR)
  const summary =
    separatorIndex === -1
      ? (error.split('\n', 1)[0] ?? '')
      : error.slice(separatorIndex + OUTBOX_ERROR_CAUSE_SEPARATOR.length)
  return boundToChars(summary, QUARANTINE_ERROR_SUMMARY_CHARS)
}

function quarantinedParentRemedy(id: number): string {
  return `retry it with ${PLATFORM_SLUG} record outbox retry orch:${id}, or retire it with ${PLATFORM_SLUG} record outbox retire orch:${id} --reason <text>`
}

export function outboxQuarantineConditions(database: Database): AddressedMonitorCondition[] {
  return quarantinedOutboxRows(database).map((row) => ({
    kind: 'outbox-quarantined',
    subject: `outbox:${row.id}`,
    since: row.quarantinedAt,
    ageMs: null,
    detail: `${row.kind} outbox row ${row.id} is quarantined: ${quarantineErrorSummary(row.error)}`,
    action: `run ${PLATFORM_SLUG} record outbox retry orch:${row.id}, or retire it with an audited reason; ${PLATFORM_SLUG} record outbox shows the full error and payload`,
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

export function outboxQuarantinedParentConditions(database: Database): AddressedMonitorCondition[] {
  return quarantinedParentHolds(database).map((row) => ({
    kind: 'outbox-quarantined-parent',
    subject: `outbox:${row.id}`,
    since: row.quarantinedAt,
    ageMs: null,
    detail: `${row.kind} outbox row ${row.id} was quarantined at ${row.quarantinedAt}; ${row.rows} pending rows wait on it`,
    action: quarantinedParentRemedy(row.id),
    ownerSession: null,
  }))
}

function outboxHeldForUpgradeConditions(
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
      detail: `${row.count} ${row.kind} outbox row(s) held; oldest age ${Math.round(ageMs / 60_000)}m; unknown columns: ${outboxHeldUnknownColumns(row.reason)}`,
      action: `run ${HOSTED_API_RELEASE_COMMAND}, or retire a row with ${PLATFORM_SLUG} record outbox retire orch:<row-id> --reason <text>`,
      ownerSession: null,
    }
  })
}

export function outboxConditions(database: Database, clock: number): AddressedMonitorCondition[] {
  return [
    ...outboxQuarantineConditions(database),
    ...outboxHeldForUpgradeConditions(database, clock),
    ...outboxQuarantinedParentConditions(database),
    ...outboxRetiredParentConditions(database),
  ]
}
