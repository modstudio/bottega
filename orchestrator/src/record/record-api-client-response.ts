// concern: record-api-client-response
/** Owns generic record API response shape and message parsing. */
import { RECORD_KEYED_NOT_VISIBLE_CODE } from './record-keyed-read.ts'
import { RECORD_TASK_FLOW_NOT_FOUND_CODE } from './record-task-flow-contract.ts'

export class RecordApiRequestError extends Error {
  readonly kind: 'unreachable' | 'server' | 'refused' | 'conflict'
  readonly status: number | null
  readonly code: string | null
  readonly existingAccount: boolean
  readonly currentRevision: string | null
  readonly reason: string | null
  readonly condition: string

  constructor(
    message: string,
    kind: 'unreachable' | 'server' | 'refused' | 'conflict',
    status: number | null = null,
    code: string | null = null,
    existingAccount = false,
    currentRevision: string | null = null,
    reason: string | null = null,
    condition = message,
  ) {
    super(message)
    this.kind = kind
    this.status = status
    this.code = code
    this.existingAccount = existingAccount
    this.currentRevision = currentRevision
    this.reason = reason
    this.condition = condition
  }
}

export function isAbsentRecordKeyedRead(error: unknown): boolean {
  return (
    error instanceof RecordApiRequestError &&
    error.status === 404 &&
    (error.code === RECORD_KEYED_NOT_VISIBLE_CODE || error.code === RECORD_TASK_FLOW_NOT_FOUND_CODE)
  )
}

export const responseRecord = (body: unknown): Record<string, unknown> =>
  body && typeof body === 'object' ? (body as Record<string, unknown>) : {}

export function responseMessage(body: unknown, fallback: string): string {
  const record = responseRecord(body)
  const nested = responseRecord(record.error)
  return (
    (typeof record.error === 'string' && record.error) ||
    (typeof record.message === 'string' && record.message) ||
    (typeof nested.message === 'string' && nested.message) ||
    fallback
  )
}

export function responseRemedy(body: unknown): string | null {
  const remedy = responseRecord(body).remedy
  return typeof remedy === 'string' && remedy.trim() ? remedy : null
}

export function responseCode(body: unknown): string | null {
  const record = responseRecord(body)
  const nested = responseRecord(record.error)
  return (
    (typeof record.code === 'string' && record.code) ||
    (typeof nested.code === 'string' && nested.code) ||
    null
  )
}
