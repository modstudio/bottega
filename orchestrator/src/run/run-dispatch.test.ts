import { expect, test } from 'bun:test'
import { spawnCwd } from './run-dispatch.ts'

test('a detached worker starts in its recorded directory, or the fallback when that is gone', () => {
  expect(spawnCwd('/unregistered', null, false, true, '/fallback')).toBe('/unregistered')
  expect(spawnCwd('/unregistered', null, false, false, '/fallback')).toBe('/fallback')
})

test('disposable-tree mutation: a registered project coordinator starts in the main checkout', () => {
  expect(spawnCwd('/repo/.claude/worktrees/live', '/repo', true, true, '/fallback')).toBe('/repo')
})
