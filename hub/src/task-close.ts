import { pruneTaskBranches } from './orch.ts'
import { closeTask, type TaskRow, type TaskScope } from './task.ts'

export async function closeThenPrune(
  key: string,
  scope: TaskScope,
  keepBranches: boolean,
  dependencies: {
    close?: (key: string, scope: TaskScope) => Promise<TaskRow>
    prune?: typeof pruneTaskBranches
  } = {},
) {
  const closed = dependencies.close
    ? await dependencies.close(key, scope)
    : await closeTask(key, scope)
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
