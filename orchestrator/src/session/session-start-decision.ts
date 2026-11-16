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
  | { kind: 'none'; cursor: number; workflow: string; key: string }
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
  const taskBound = input.openCursors.find((cursor) => cursor.workflowKey)
  if (taskBound)
    return {
      kind: 'none',
      cursor: taskBound.id,
      workflow: taskBound.workflow,
      key: taskBound.workflowKey,
    }
  const held = input.openCursors.find((cursor) => cursor.workflow === 'explore')
  return held ? { kind: 'reuse', cursor: held.id, workflow: held.workflow } : { kind: 'compose' }
}
