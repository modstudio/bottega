// concern: record-keyed-read
/** Owns hosted record routes whose UUID keys are unique across record spaces. */

import { RecordApiRequestError } from './record-api-client-response.ts'
import { RECORD_TASK_FLOW_NOT_FOUND_CODE } from './record-task-flow-contract.ts'

export const RECORD_KEYED_NOT_VISIBLE_CODE = 'record_not_visible'

export function isAbsentRecordKeyedRead(error: unknown): boolean {
  return (
    error instanceof RecordApiRequestError &&
    error.status === 404 &&
    (error.code === RECORD_KEYED_NOT_VISIBLE_CODE ||
      error.code === RECORD_TASK_FLOW_NOT_FOUND_CODE)
  )
}

export function recordRequestReadKind(
  route: string,
  query: (name: string) => string | undefined,
): string | undefined {
  if (route === '/v1/questions') return query('read')
  if (route === '/v1/task-flow' && query('flowRecordId')) return 'flow'
  return undefined
}

export function recordReadIsUuidKeyed(route: string, readKind?: string): boolean {
  if (route === '/v1/questions')
    return ['by-id', 'for-run', 'for-runs', 'for-cursor', 'open-for-cursors'].includes(
      readKind ?? '',
    )
  if (route === '/v1/task-flow') return readKind === 'flow'
  return /^\/v1\/task-flow\/(stages|texts|obligations)\/[^/]+$/.test(route)
}

export function recordKeyedNotVisibleRefusal(memberships: number) {
  return {
    error: `not visible in your record spaces (${memberships} memberships)`,
    remedy:
      'the row is in a space you are not a member of, or it does not exist; join its space or check the id',
    code: RECORD_KEYED_NOT_VISIBLE_CODE,
  }
}
