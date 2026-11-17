import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { decideHeldBranchRemedy, heldBranchRemedyText } from './held-branch-remedy.ts'

describe('held branch remedy', () => {
  test.each(
    [false, true].flatMap((cwdInsideTree) =>
      [false, true].flatMap((cursorNamesTree) =>
        [false, true].map((treeDirty) => ({ cwdInsideTree, cursorNamesTree, treeDirty })),
      ),
    ),
  )(
    'clears the hold for cwd=$cwdInsideTree cursor=$cursorNamesTree dirty=$treeDirty',
    ({ cwdInsideTree, cursorNamesTree, treeDirty }) => {
      const remedy = decideHeldBranchRemedy({
        path: '/worktrees/DEV-2405',
        cwdInsideTree,
        cursorNamesTree,
        treeDirty,
      })
      const text = heldBranchRemedyText(remedy)
      const treeMustStay = cwdInsideTree || cursorNamesTree

      expect(remedy.release).toBe(
        treeMustStay
          ? 'git -C /worktrees/DEV-2405 checkout --detach'
          : `${PLATFORM_SLUG} tree remove /worktrees/DEV-2405`,
      )
      expect(remedy.prepare !== null).toBe(treeDirty)
      if (cursorNamesTree) expect(text).not.toContain('tree remove')
      if (treeDirty) expect(text).toContain('commit or stash')
    },
  )
})
