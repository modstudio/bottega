// concern: record-keyed-read
/** Owns hosted record routes whose UUID keys are unique across record spaces. */

export const RECORD_KEYED_NOT_VISIBLE_CODE = 'record_not_visible'

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
