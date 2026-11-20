// concern: hosted-push-conflict
/** Typed whole-batch refusals for guarded hub changes. */

import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { refusal, renderRefusal } from '../../shared/refusal.ts'
import type { PushableHubChangeTable } from './push-contract.ts'

export class HostedRevisionConflictError extends Error {
  readonly status = 409
  readonly appliedIndex: number
  readonly table: PushableHubChangeTable
  readonly id: string
  readonly condition: string
  readonly currentRevision: string | null
  readonly field: string | undefined
  readonly currentValue: unknown

  constructor(
    table: PushableHubChangeTable,
    id: string,
    message: string,
    condition: string,
    currentRevision: string | null,
    appliedIndex: number,
    field?: string,
    currentValue?: unknown,
  ) {
    super(message)
    this.table = table
    this.id = id
    this.condition = condition
    this.currentRevision = currentRevision
    this.field = field
    this.currentValue = currentValue
    this.appliedIndex = appliedIndex
  }
}

export class HostedChangeIdMismatchError extends Error {
  readonly status = 422
  readonly appliedIndex: number
  readonly table: PushableHubChangeTable
  readonly id: string
  readonly changeId: string

  constructor(table: PushableHubChangeTable, id: string, changeId: string, appliedIndex: number) {
    super(`change_id ${changeId} was already applied with a different payload`)
    this.table = table
    this.id = id
    this.changeId = changeId
    this.appliedIndex = appliedIndex
  }
}

function conflictRemedy(table: PushableHubChangeTable, key: string) {
  return table === 'hub_note'
    ? { kind: 'command' as const, argv: [PLATFORM_SLUG, 'note', 'list', '--json'] }
    : { kind: 'command' as const, argv: [PLATFORM_SLUG, 'task', 'show', key] }
}

export function revisionConflict(input: {
  table: PushableHubChangeTable
  id: string
  expected: number | string
  current: number | string | null
  key: string
  appliedIndex: number
}): HostedRevisionConflictError {
  const currentRevision = input.current === null ? null : String(input.current)
  const rejected = refusal(
    `${input.table} ${input.id} changed since revision ${input.expected}; now ${currentRevision}.`,
    conflictRemedy(input.table, input.key),
  )
  return new HostedRevisionConflictError(
    input.table,
    input.id,
    renderRefusal(rejected),
    rejected.condition,
    currentRevision,
    input.appliedIndex,
  )
}

export function fieldConflict(input: {
  table: PushableHubChangeTable
  id: string
  key: string
  field: string
  currentValue: unknown
  currentRevision: number | string | null
  appliedIndex: number
}): HostedRevisionConflictError {
  const rejected = refusal(
    `${input.table} ${input.id} field ${input.field} changed; now ${JSON.stringify(input.currentValue)}`,
    conflictRemedy(input.table, input.key),
  )
  return new HostedRevisionConflictError(
    input.table,
    input.id,
    renderRefusal(rejected),
    rejected.condition,
    input.currentRevision === null ? null : String(input.currentRevision),
    input.appliedIndex,
    input.field,
    input.currentValue,
  )
}

export type HostedRevisionConflictBody = {
  error: string
  code: 'revision-conflict'
  reason: 'stale-revision'
  condition: string
  currentRevision: string | null
  index: number
  table: PushableHubChangeTable
  id: string
  field?: string
  currentValue?: unknown
}

export function revisionConflictBody(
  error: HostedRevisionConflictError,
  index: number,
): HostedRevisionConflictBody {
  return {
    error: error.message,
    code: 'revision-conflict' as const,
    reason: 'stale-revision' as const,
    condition: error.condition,
    currentRevision: error.currentRevision,
    index,
    table: error.table,
    id: error.id,
    ...(error.field === undefined
      ? {}
      : { field: error.field, currentValue: error.currentValue ?? null }),
  }
}

export function changeIdMismatchBody(error: HostedChangeIdMismatchError, index: number) {
  return {
    error: error.message,
    code: 'change-id-mismatch' as const,
    index,
    table: error.table,
    id: error.id,
    change_id: error.changeId,
  }
}
