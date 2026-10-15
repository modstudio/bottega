import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateFocusedTestPaths } from './focused-test-paths.ts'

const roots: string[] = []
const directory = (name: string) => {
  const root = mkdtempSync(join(tmpdir(), name))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test('filesystem facts expose a symlink escape to the pure confinement decision', () => {
  const tree = directory('focused-tree-')
  const outside = directory('focused-outside-')
  writeFileSync(join(outside, 'escape.test.ts'), '')
  symlinkSync(join(outside, 'escape.test.ts'), join(tree, 'escape.test.ts'))
  expect(() => validateFocusedTestPaths(['escape.test.ts'], tree)).toThrow(
    'focused test path "escape.test.ts" resolves outside the run worktree',
  )
})
