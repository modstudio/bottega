// concern: held-branch remedy
/** Gathers and renders the operator remedy for a branch held by another tree. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { realpathOrSpelled } from '../git/checkout-identity.ts'
import { gitResult } from '../git/git-environment.ts'
import { openCursorWorktrees } from '../workflow/workflow-cursor-worktrees.ts'

export type HeldBranchRemedyFacts = {
  path: string
  cwdInsideTree: boolean
  cursorNamesTree: boolean
  treeDirty: boolean
}

export type HeldBranchRemedy = {
  prepare: string | null
  release: 'detach' | 'remove'
}

/** Gather the resolved path, hosted cursor, and dirty facts for one held tree. */
export async function heldBranchRemedyFacts(path: string): Promise<HeldBranchRemedyFacts> {
  const tree = realpathOrSpelled(path).replace(/\/$/, '')
  const cwd = realpathOrSpelled(process.cwd()).replace(/\/$/, '')
  const dirty = gitResult(['status', '--porcelain'], path)
  const cursorWorktrees = await openCursorWorktrees()
  return {
    path,
    cwdInsideTree: cwd === tree || cwd.startsWith(`${tree}/`),
    cursorNamesTree: cursorWorktrees.some(
      ({ worktree }) => realpathOrSpelled(worktree).replace(/\/$/, '') === tree,
    ),
    treeDirty: !dirty.ok || dirty.stdout.length > 0,
  }
}

/** Choose a release that preserves a tree still named by the operator's live context. */
export function decideHeldBranchRemedy(facts: HeldBranchRemedyFacts): HeldBranchRemedy {
  return {
    prepare: facts.treeDirty ? `commit or stash the work in ${facts.path} first` : null,
    release: facts.cwdInsideTree || facts.cursorNamesTree ? 'detach' : 'remove',
  }
}

/** Render a held-tree decision with the operator command vocabulary. */
export function renderHeldBranchRemedy(path: string, remedy: HeldBranchRemedy): string {
  const release =
    remedy.release === 'detach'
      ? `git -C ${path} checkout --detach`
      : `${PLATFORM_SLUG} tree remove ${path}`
  return remedy.prepare ? `${remedy.prepare}, then ${release}` : release
}

/** Gather, decide, and render the release for one held tree. */
export async function heldBranchRemedy(path: string): Promise<string> {
  return renderHeldBranchRemedy(path, decideHeldBranchRemedy(await heldBranchRemedyFacts(path)))
}
