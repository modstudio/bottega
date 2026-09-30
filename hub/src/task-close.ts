import { pruneTaskBranches } from './orch.ts'
import { closeTask, type TaskRow, type TaskScope } from './task.ts'

export async function closeThenPrune(
  key: string,
  scope: TaskScope,
  keepBranches: boolean,
  abandonReason: string | undefined,
  dependencies: {
    close?: (key: string, scope: TaskScope, options: { abandonReason?: string }) => Promise<TaskRow>
    prune?: typeof pruneTaskBranches
  } = {},
) {
  const closed = dependencies.close
    ? await dependencies.close(key, scope, { abandonReason })
    : await closeTask(key, scope, { abandonReason })
  if (keepBranches) return { closed, pruned: null, pruneError: null }
  try {
    return {
      closed,
      pruned: await (dependencies.prune ?? pruneTaskBranches)(closed.project, closed.key),
      pruneError: null,
    }
  } catch (error) {
    return { closed, pruned: null, pruneError: error as Error }
  }
}
