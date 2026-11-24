// concern: confined worker hosted-record scope
/** Decides whether one authenticated worker read stays inside its run-bound task scope. */

import { RUN_LIVE_STATUS_SET } from '../run/run-status.ts'

export type WorkerRecordScopeFacts = {
  authenticated: boolean
  runStatus: string | null
  runTaskId: string | null
  runTaskKey: string | null
  runProjectId: string | null
  runSpaceId: string | null
  allowedTaskIds: readonly string[]
  allowedTaskKeys: readonly string[]
}

export type WorkerRecordReadTarget = {
  kind: 'task' | 'task-document' | 'workflow-text'
  taskId: string | null
  taskKey: string | null
  projectId: string | null
  spaceId: string | null
}

export type WorkerRecordScopeDecision = { allowed: true } | { allowed: false; reason: string }

export function workerRecordScopeName(facts: WorkerRecordScopeFacts): string {
  const task = facts.runTaskKey ?? facts.runTaskId ?? '(unbound task)'
  return `run task ${task} and its parent chain in record space ${facts.runSpaceId ?? '(unbound space)'}`
}

export function decideWorkerRecordReadScope(
  facts: WorkerRecordScopeFacts,
  target: WorkerRecordReadTarget,
): WorkerRecordScopeDecision {
  const scope = workerRecordScopeName(facts)
  if (!facts.authenticated)
    return { allowed: false, reason: `read refused: the caller is not authenticated for ${scope}` }
  if (!facts.runStatus || !RUN_LIVE_STATUS_SET.has(facts.runStatus))
    return { allowed: false, reason: `read refused: the run is terminal; its scope was ${scope}` }
  if (!facts.runTaskId || !facts.runProjectId || !facts.runSpaceId)
    return { allowed: false, reason: `read refused: the run does not establish ${scope}` }
  if (target.spaceId !== facts.runSpaceId)
    return { allowed: false, reason: `read refused: the requested record is outside ${scope}` }
  if (target.projectId !== facts.runProjectId)
    return { allowed: false, reason: `read refused: the requested project is outside ${scope}` }
  const taskAllowed =
    (target.taskId !== null && facts.allowedTaskIds.includes(target.taskId)) ||
    (target.taskKey !== null && facts.allowedTaskKeys.includes(target.taskKey.toUpperCase()))
  if (!taskAllowed)
    return {
      allowed: false,
      reason: `read refused: the requested ${target.kind} is outside ${scope}`,
    }
  return { allowed: true }
}
