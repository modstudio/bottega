import { expect, test } from 'bun:test'
import { spawnCwd } from './run-dispatch.ts'

test('a detached worker starts in its recorded directory, or the fallback when that is gone', () => {
  const present = new Set(['/repo/.claude/worktrees/live'])
  const exists = (path: string) => present.has(path)

  expect(spawnCwd('/repo/.claude/worktrees/live', '/repo', exists)).toBe(
    '/repo/.claude/worktrees/live',
  )
  expect(spawnCwd('/repo/.claude/worktrees/discarded', '/repo', exists)).toBe('/repo')
})
