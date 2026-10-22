import { expect, test } from 'bun:test'
import {
  alreadyReleasedWorktreeLine,
  discardWorktreeAbsence,
} from './discard-worktree-absence.ts'

test('discard treats a close-out release as already released, not as never having a tree', () => {
  expect(discardWorktreeAbsence('released')).toBe('already-released')
  expect(discardWorktreeAbsence('absent')).toBe('already-released')
  expect(discardWorktreeAbsence('forgotten')).toBe('already-released')
  expect(discardWorktreeAbsence('held')).toBe('none')
  expect(discardWorktreeAbsence(null)).toBe('none')
  expect(alreadyReleasedWorktreeLine('42')).toBe(
    "run 42's worktree was already released by stop or close-out",
  )
})
