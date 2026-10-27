import { expect, test } from 'bun:test'
import {
  snapshotlessTrackedRecipeRefusal,
  unownedProjectTreeRemovalRemedy,
} from './snapshotless-tracked-recipe.ts'

const input = {
  treePath: '/projects/alpha/.claude/worktrees/unrecorded',
  mainCheckoutPath: '/projects/alpha',
}

test('an unowned tree remedy names its creator tool and the plain-git fallback paths', () => {
  expect(unownedProjectTreeRemovalRemedy(input)).toBe(
    "if the orchestrator did not make this tree, remove it with the tool that made it, so whatever that tool provisioned for the tree is released too (a project's own worktree command, for example); only a plain git worktree is removed with git -C /projects/alpha worktree remove /projects/alpha/.claude/worktrees/unrecorded, after confirming it is clean and its commits are pushed",
  )
})

test('a rowless tracked tree is refused because its provisioning cannot be established', () => {
  expect(
    snapshotlessTrackedRecipeRefusal({ ...input, hasRunRow: false, trackedRecipe: true }),
  ).toStartWith(
    'no orchestrator run records the worktree at /projects/alpha/.claude/worktrees/unrecorded; what its tracked recipe provisioned cannot be established, so the orchestrator will not tear it down;',
  )
})

test('a run row or an untracked recipe needs no snapshotless refusal', () => {
  expect(
    snapshotlessTrackedRecipeRefusal({ ...input, hasRunRow: true, trackedRecipe: true }),
  ).toBeNull()
  expect(
    snapshotlessTrackedRecipeRefusal({ ...input, hasRunRow: false, trackedRecipe: false }),
  ).toBeNull()
})
