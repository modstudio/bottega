// concern: session start
/** Pure idempotence and entry decision for a session's explore workflow. */

export type SessionStartCursor = {
  id: number
  workflow: string
  workflowKey: string
}

export type SessionStartDecision =
  | { kind: 'reuse'; cursor: number; workflow: string }
  | { kind: 'compose' }
  | { kind: 'none' }
  | { kind: 'refuse-session' }
  | { kind: 'refuse-project' }

/**
 * Does this session already hold open task-bound work or an explore cursor? The store owns the
 * definition of open, so the decision receives only open cursors.
 */
export function decideSessionStart(input: {
  session: string | null
  project: string | null
  openCursors: readonly SessionStartCursor[]
}): SessionStartDecision {
  if (!input.session) return { kind: 'refuse-session' }
  if (!input.project) return { kind: 'refuse-project' }
  if (input.openCursors.some((cursor) => cursor.workflowKey)) return { kind: 'none' }
  const held = input.openCursors.find((cursor) => cursor.workflow === 'explore')
  return held ? { kind: 'reuse', cursor: held.id, workflow: held.workflow } : { kind: 'compose' }
}
