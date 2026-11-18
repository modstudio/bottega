// concern: hook-tree
/** Owns hook-tree command behavior. Must not know CLI grammar. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { openLandingTree } from '../landing-tree/tree.ts'
import { projectAt } from '../project/projects.ts'
import { bindTaskKeyWorktree } from '../workflow/workflow-cursor-binding.ts'
import { createHookTree, removeHookTree } from './tree.ts'
export async function treeCreateCommand(
  options: { cwd: string; name: string; key?: string; base?: string; seed?: string },
  presentation: { writePath(path: string): void; error(message: string): void },
): Promise<void> {
  const project = projectAt(options.cwd)
  if (!project) {
    throw new Error(
      `cwd ${options.cwd} is not inside a registered project; run ${PLATFORM_SLUG} project list and retry with --cwd inside one of its paths`,
    )
  }
  const path = createHookTree(options)
  presentation.writePath(path)
  if (!options.key) return
  let result: Awaited<ReturnType<typeof bindTaskKeyWorktree>>
  try {
    result = await bindTaskKeyWorktree({
      project: project.name,
      key: options.key,
      worktree: path,
    })
  } catch (error) {
    presentation.error(
      `workflow cursor for task ${options.key} argument binding failed: ${String((error as Error)?.message ?? error)}`,
    )
    return
  }
  if (result.action === 'ambiguous') {
    presentation.error(
      `worktree was not bound: task ${options.key} has multiple open workflow cursors (${result.cursors.join(', ')})`,
    )
  }
  if (result.action === 'refused') presentation.error(result.warning)
}

export async function treeRemoveCommand(path: string): Promise<void> {
  await removeHookTree(path)
}

export async function treeOpenCommand(
  runId: string,
  seed: string | undefined,
  presentation: { log(value: string): void; error(message: string): void },
): Promise<void> {
  const opened = await openLandingTree(runId, seed)
  if (opened.warning) presentation.error(opened.warning)
  presentation.log(`tree: ${opened.path}`)
  presentation.log(`branch: ${opened.branch}`)
  presentation.log(`tip: ${opened.tip}`)
  presentation.log(`release: ${PLATFORM_SLUG} tree remove ${opened.path}`)
}
