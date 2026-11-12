// concern: session start
/** Pure idempotence and entry decision for a session's explore workflow. */

export type SessionStartCursor = {
  id: number
  workflow: string
  state: string
}

export type SessionStartDecision =
  | { kind: 'reuse'; cursor: number }
  | { kind: 'compose' }
  | { kind: 'refuse-session' }
  | { kind: 'refuse-project' }

/** Does this session already hold an open explore cursor? */
export function decideSessionStart(input: {
  session: string | null
  project: string | null
  cursors: readonly SessionStartCursor[]
}): SessionStartDecision {
  if (!input.session) return { kind: 'refuse-session' }
  if (!input.project) return { kind: 'refuse-project' }
  const existing = input.cursors.find(
    (cursor) =>
      cursor.workflow === 'explore' && cursor.state !== 'done' && cursor.state !== 'abandoned',
  )
  return existing ? { kind: 'reuse', cursor: existing.id } : { kind: 'compose' }
}
