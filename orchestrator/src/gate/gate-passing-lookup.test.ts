import { expect, test } from 'bun:test'
import { selectPassingGateNumber } from './gate-passing-lookup.ts'

test('a passing gate belongs to the exact project', () => {
  const candidates = [
    { recordId: 'c', number: 3, projectId: 'project-2', cwd: null },
    { recordId: 'b', number: 2, projectId: null, cwd: '/projects/fixture/worktree' },
    { recordId: 'a', number: 1, projectId: 'project-1', cwd: null },
  ]
  expect(selectPassingGateNumber(candidates, 'project-1', () => 'project-1')).toBe(2)
  expect(selectPassingGateNumber(candidates, 'project-1', () => 'project-2')).toBe(1)
  expect(selectPassingGateNumber(candidates, 'project-4', () => 'project-2')).toBeNull()
})
