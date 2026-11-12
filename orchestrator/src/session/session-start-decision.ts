// concern: session start
/** Pure idempotence and entry decision for a session's explore workflow. */

export type SessionStartCursor = {
  id: number
  workflow: string
  state: string
}

export type SessionStartDecision =
  | { kind: 'reuse'; cursor: number; workflow: string }
  | { kind: 'compose' }
  | { kind: 'refuse-session' }
  | { kind: 'refuse-project' }

const isOpen = (cursor: SessionStartCursor) =>
  cursor.state !== 'done' && cursor.state !== 'abandoned'

/**
 * Does this session already work inside a workflow? Explore opens only when the session
 * holds no open cursor, so a session that closed explore to take up a task keeps that choice.
 */
export function decideSessionStart(input: {
  session: string | null
  project: string | null
  cursors: readonly SessionStartCursor[]
}): SessionStartDecision {
  if (!input.session) return { kind: 'refuse-session' }
  if (!input.project) return { kind: 'refuse-project' }
  const open = input.cursors.filter(isOpen)
  const held =
    open.find((cursor) => cursor.workflow === 'explore') ??
    open.reduce<SessionStartCursor | undefined>(
      (latest, cursor) => (!latest || cursor.id > latest.id ? cursor : latest),
      undefined,
    )
  return held ? { kind: 'reuse', cursor: held.id, workflow: held.workflow } : { kind: 'compose' }
}
