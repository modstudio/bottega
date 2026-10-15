// concern: worktree removal working directory
/** Decides whether removing a tree would remove the caller's working directory. */

import { realpathSync } from 'node:fs'
import { isAbsolute, relative, sep } from 'node:path'

/** Both inputs are real paths. */
export function workingDirectoryIsInsideTree(
  workingDirectoryRealPath: string,
  treeRealPath: string,
): boolean {
  const relation = relative(treeRealPath, workingDirectoryRealPath)
  return (
    relation === '' ||
    (relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation))
  )
}

/** Refuse only when both existing paths can be identified. An absent cwd cannot be removed again. */
export function removalWorkingDirectoryRefusal(
  treePath: string,
  mainCheckout: string,
  cwd: () => string = process.cwd,
): string | null {
  try {
    const workingDirectory = realpathSync(cwd())
    const tree = realpathSync(treePath)
    if (!workingDirectoryIsInsideTree(workingDirectory, tree)) return null
    return (
      `refusing to remove ${treePath}: current working directory ${workingDirectory} is inside it\n` +
      'invariant: Worktree removal does not remove the process current working directory.\n' +
      `cleared by: run this command from the main checkout ${mainCheckout}`
    )
  } catch {
    return null
  }
}
