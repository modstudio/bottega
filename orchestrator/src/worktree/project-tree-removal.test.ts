import { expect, test } from 'bun:test'
import { unownedProjectTreeRemovalRemedy } from './project-tree-removal.ts'

const input = {
  treePath: '/projects/alpha/.claude/worktrees/unrecorded',
  mainCheckoutPath: '/projects/alpha',
}

test('an unowned tree remedy uses the project-declared removal command', () => {
  expect(
    unownedProjectTreeRemovalRemedy({
      ...input,
      declaredRemoveCommand: "bun run worktree remove 'unrecorded'",
    }),
  ).toBe(
    "if the orchestrator did not make this tree, confirm it is clean and its commits are pushed, then run bun run worktree remove 'unrecorded', which also releases what the project provisioned for it",
  )
})

test('an unowned tree remedy falls back to git when the project declares no removal', () => {
  expect(unownedProjectTreeRemovalRemedy({ ...input, declaredRemoveCommand: null })).toBe(
    'if the orchestrator did not make this tree, confirm it is clean and its commits are pushed, then run git -C /projects/alpha worktree remove /projects/alpha/.claude/worktrees/unrecorded',
  )
})
