// concern: hook-tree
/** Owns hook-tree command behavior. Must not know CLI grammar. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { openLandingTree } from '../landing-tree/tree.ts'
import { createHookTree, removeHookTree } from './tree.ts'
export function treeCreateCommand(
  options: { cwd: string; name: string; key?: string; base?: string; seed?: string },
  presentation: { writePath(path: string): void },
): void {
  presentation.writePath(createHookTree(options))
}

export async function treeRemoveCommand(path: string): Promise<void> {
  await removeHookTree(path)
}

export async function treeOpenCommand(
  runId: string,
  seed: string | undefined,
  presentation: { log(value: string): void },
): Promise<void> {
  const opened = await openLandingTree(runId, seed)
  presentation.log(`tree: ${opened.path}`)
  presentation.log(`branch: ${opened.branch}`)
  presentation.log(`tip: ${opened.tip}`)
  presentation.log(`release: ${PLATFORM_SLUG} tree remove ${opened.path}`)
}
