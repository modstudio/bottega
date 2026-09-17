// concern: hook-tree
/** Owns hook-tree command behavior. Must not know CLI grammar. */

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
