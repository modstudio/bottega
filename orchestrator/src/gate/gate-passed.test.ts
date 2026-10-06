import { expect, test } from 'bun:test'
import { formatPassingGate, selectPassingGateId } from './gate-passed.ts'

test('a passing gate belongs to the exact project', () => {
  const candidates = [
    { id: 3, projectId: 2, cwd: null },
    { id: 2, projectId: null, cwd: '/projects/fixture/worktree' },
    { id: 1, projectId: 1, cwd: null },
  ]
  expect(selectPassingGateId(candidates, 1, () => 1)).toBe(2)
  expect(selectPassingGateId(candidates, 1, () => 2)).toBe(1)
  expect(selectPassingGateId(candidates, 4, () => 2)).toBeNull()
})

test('the hook result is one line for either outcome', () => {
  expect(formatPassingGate({ project: 'fixture', commit: 'abc', gateId: 9 })).toBe(
    'passing gate 9 recorded for fixture commit abc',
  )
  expect(formatPassingGate({ project: 'fixture', commit: 'abc', gateId: null })).toBe(
    'no passing gate recorded for fixture commit abc',
  )
})
