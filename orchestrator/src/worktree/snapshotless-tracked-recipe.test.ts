import { expect, test } from 'bun:test'
import { snapshotlessTrackedRecipeRefusal } from './snapshotless-tracked-recipe.ts'

const input = {
  treePath: '/projects/alpha/.claude/worktrees/unrecorded',
  mainCheckoutPath: '/projects/alpha',
}

test('rowless tracked tree refusal names the manual git removal command', () => {
  expect(
    snapshotlessTrackedRecipeRefusal({ ...input, hasRunRow: false, trackedRecipe: true }),
  ).toContain('git -C /projects/alpha worktree remove /projects/alpha/.claude/worktrees/unrecorded')
})

test('a run row or an untracked recipe needs no snapshotless refusal', () => {
  expect(
    snapshotlessTrackedRecipeRefusal({ ...input, hasRunRow: true, trackedRecipe: true }),
  ).toBeNull()
  expect(
    snapshotlessTrackedRecipeRefusal({ ...input, hasRunRow: false, trackedRecipe: false }),
  ).toBeNull()
})
