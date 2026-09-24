import { pruneTaskBranches } from './orch.ts'
import { closeTask, type TaskRow } from './task.ts'

export async function closeThenPrune(
  key: string,
  keepBranches: boolean,
  dependencies: {
    close?: (key: string) => Promise<TaskRow>
    prune?: typeof pruneTaskBranches
  } = {},
  project?: string,
) {
  const closed = dependencies.close
    ? await dependencies.close(key)
    : await closeTask(key, { scope: { project } })
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
