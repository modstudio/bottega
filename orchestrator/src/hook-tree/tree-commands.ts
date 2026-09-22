// concern: hook-tree
/** Owns hook-tree command behavior. Must not know CLI grammar. */

import { openLandingTree } from '../landing-tree/tree.ts'
import { createHookTree, removeHookTree } from './tree.ts'

export function treeCreateCommand(
  options: { cwd: string; name: string; key?: string; base?: string },
  presentation: { writePath(path: string): void },
): void {
  presentation.writePath(createHookTree(options))
}

export function treeRemoveCommand(path: string): void {
  removeHookTree(path)
}

export function treeOpenCommand(
  runId: number,
  seed: string | undefined,
  presentation: { log(value: string): void },
): void {
  const opened = openLandingTree(runId, seed)
  presentation.log(`tree: ${opened.path}`)
  presentation.log(`branch: ${opened.branch}`)
  presentation.log(`tip: ${opened.tip}`)
  presentation.log(`release: orch tree remove ${opened.path}`)
}
