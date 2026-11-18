// concern: hook-tree
/** Owns hook-tree command behavior. Must not know CLI grammar. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { openLandingTree } from '../landing-tree/tree.ts'
import { projectAt } from '../project/projects.ts'
import { bindTaskKeyWorktree } from '../workflow/workflow-cursor-binding.ts'
import { createHookTree, removeHookTree } from './tree.ts'
export async function treeCreateCommand(
  options: { cwd: string; name: string; key?: string; base?: string; seed?: string },
  presentation: { writePath(path: string): void },
): Promise<void> {
  const path = createHookTree(options)
  presentation.writePath(path)
  if (!options.key) return
  const result = await bindTaskKeyWorktree({
    project: projectAt(options.cwd)!.name,
    key: options.key,
    worktree: path,
  })
  if (result.action === 'ambiguous') {
    presentation.writePath(
      `worktree was not bound: task ${options.key} has multiple open workflow cursors (${result.cursors.join(', ')})`,
    )
  }
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
