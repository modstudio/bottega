import { expect, test } from 'bun:test'
import { machinePermissionListPresentation } from './settings.ts'

const overlay = {
  additions: { allow: ['Bash(git status)'], ask: [], deny: [] },
  drop: { allow: [], ask: ['Bash(rm *)'], deny: [] },
}

test('machine permission listing presents JSON and one line per rule', () => {
  expect(machinePermissionListPresentation(overlay, true)).toEqual([JSON.stringify(overlay)])
  expect(machinePermissionListPresentation(overlay, false)).toEqual([
    'allow\tadditions\tBash(git status)',
    'ask\tdrop\tBash(rm *)',
  ])
})
