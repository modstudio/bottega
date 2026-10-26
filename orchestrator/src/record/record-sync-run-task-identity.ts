// concern: record-sync-run-task-identity
/** Chooses the hosted task link for a run from task matches gathered in its space. */
export function runTaskIdentityDecision(input: {
  payloadTaskId?: string | null
  payloadTaskKey?: string | null
  taskFoundById: string | null
  taskFoundByKey: string | null
  existingTaskId: string | null
  write: 'insert' | 'update'
}): string | null {
  if (input.payloadTaskId != null && input.taskFoundById !== null) return input.taskFoundById
  if (input.payloadTaskKey != null && input.taskFoundByKey !== null) return input.taskFoundByKey
  return input.write === 'update' ? input.existingTaskId : null
}
