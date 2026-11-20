// concern: hosted-push-conflict
/** Typed whole-batch refusals for guarded hub changes. */

import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { refusal, renderRefusal } from '../../shared/refusal.ts'
import type { PushableHubChangeTable } from './push-contract.ts'

export class HostedRevisionConflictError extends Error {
  readonly status = 409
  index = -1
  readonly table: PushableHubChangeTable
  readonly id: string
  readonly condition: string
  readonly currentRevision: string | null
  readonly field: string | undefined
  readonly currentValue: unknown

  constructor(
    table: PushableHubChangeTable,
    id: string,
    condition: string,
    currentRevision: string | null,
    field?: string,
    currentValue?: unknown,
  ) {
    super(condition)
    this.table = table
    this.id = id
    this.condition = condition
    this.currentRevision = currentRevision
    this.field = field
    this.currentValue = currentValue
  }
}

export class HostedChangeIdMismatchError extends Error {
  readonly status = 422
  index = -1
  readonly table: PushableHubChangeTable
  readonly id: string
  readonly changeId: string

  constructor(table: PushableHubChangeTable, id: string, changeId: string) {
    super(`change_id ${changeId} was already applied with a different payload`)
    this.table = table
    this.id = id
    this.changeId = changeId
  }
}

export function revisionConflict(input: {
  table: PushableHubChangeTable
  id: string
  expected: number | string
  current: number | string | null
  key: string
}): HostedRevisionConflictError {
  const currentRevision = input.current === null ? null : String(input.current)
  return new HostedRevisionConflictError(
    input.table,
    input.id,
    renderRefusal(
      refusal(
        `${input.table} ${input.id} changed since revision ${input.expected}; now ${currentRevision}.`,
        { kind: 'command', argv: [PLATFORM_SLUG, 'task', 'show', input.key] },
      ),
    ),
    currentRevision,
  )
}

export function fieldConflict(input: {
  table: PushableHubChangeTable
  id: string
  field: string
  currentValue: unknown
  currentRevision: number | string | null
}): HostedRevisionConflictError {
  return new HostedRevisionConflictError(
    input.table,
    input.id,
    `${input.table} ${input.id} field ${input.field} changed; now ${JSON.stringify(input.currentValue)}`,
    input.currentRevision === null ? null : String(input.currentRevision),
    input.field,
    input.currentValue,
  )
}

export function revisionConflictBody(error: HostedRevisionConflictError) {
  return {
    error: error.message,
    code: 'revision-conflict' as const,
    reason: 'stale-revision' as const,
    condition: error.condition,
    currentRevision: error.currentRevision,
    index: error.index,
    table: error.table,
    id: error.id,
    ...(error.field === undefined
      ? {}
      : { field: error.field, currentValue: error.currentValue ?? null }),
  }
}

export function changeIdMismatchBody(error: HostedChangeIdMismatchError) {
  return {
    error: error.message,
    code: 'change-id-mismatch' as const,
    index: error.index,
    table: error.table,
    id: error.id,
    change_id: error.changeId,
  }
}
