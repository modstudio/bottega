// concern: record-sync-run-task-identity
/** Chooses the hosted task link for a run from a reference resolved in its space. */
export function runTaskIdentityDecision(input: {
  resolvedTaskId: string | null
  existingTaskId: string | null
  write: 'insert' | 'update'
}): string | null {
  if (input.resolvedTaskId !== null) return input.resolvedTaskId
  return input.write === 'update' ? input.existingTaskId : null
}
