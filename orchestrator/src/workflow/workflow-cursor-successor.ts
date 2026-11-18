// concern: workflow cursor lineage
/** Resolves an evidence binding forward through handoff links without rewriting evidence. */

export type WorkflowCursorHandoffLink = {
  record_id: string
  handed_off_from_record_id: string | null
}

export function resolveWorkflowCursorSuccessor(
  recordId: string | null,
  rows: readonly WorkflowCursorHandoffLink[],
): string | null {
  if (!recordId) return null
  const successors = new Map(
    rows
      .filter((row) => row.handed_off_from_record_id !== null)
      .map((row) => [row.handed_off_from_record_id!, row.record_id]),
  )
  let current = recordId
  const visited = new Set<string>()
  while (!visited.has(current)) {
    visited.add(current)
    const successor = successors.get(current)
    if (!successor) break
    current = successor
  }
  return current
}
