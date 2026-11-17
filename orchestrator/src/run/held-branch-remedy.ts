// concern: held branch remedy
/** Decides how to release a branch from an architect-owned worktree. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'

export type HeldBranchRemedyFacts = {
  path: string
  cwdInsideTree: boolean
  cursorNamesTree: boolean
  treeDirty: boolean
}

export type HeldBranchRemedy = {
  prepare: string | null
  release: string
}

/** Choose a remedy whose release step is valid while every named tree holder remains valid. */
export function decideHeldBranchRemedy(facts: HeldBranchRemedyFacts): HeldBranchRemedy {
  const treeMustStay = facts.cwdInsideTree || facts.cursorNamesTree
  return {
    prepare: facts.treeDirty ? `commit or stash the work in ${facts.path} first` : null,
    release: treeMustStay
      ? `git -C ${facts.path} checkout --detach`
      : `${PLATFORM_SLUG} tree remove ${facts.path}`,
  }
}

export function heldBranchRemedyText(remedy: HeldBranchRemedy): string {
  return remedy.prepare ? `${remedy.prepare}, then ${remedy.release}` : remedy.release
}
