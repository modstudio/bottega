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

export type RunProjectTaskIdentityDecision = {
  projectId: string | null
  taskId: string | null
  refusal: string | null
}

/** Fills a task-only run's project and requires ordinary runs to retain at least one link. */
export function runProjectTaskIdentityDecision(input: {
  runId: string
  payloadProjectId: string | null
  taskId: string | null
  taskProjectId: string | null
  probe: boolean
  commandName: string
}): RunProjectTaskIdentityDecision {
  const projectId = input.payloadProjectId ?? (input.taskId === null ? null : input.taskProjectId)
  const refusal =
    !input.probe && projectId === null && input.taskId === null
      ? `run ${input.runId} has no hosted project or task; give the local run a project or task, then run \`${input.commandName} record push --backfill\``
      : null
  return { projectId, taskId: input.taskId, refusal }
}
