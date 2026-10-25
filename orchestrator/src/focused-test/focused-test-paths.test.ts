import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FOCUSED_TEST_MAX_PATHS } from './focused-test-decision.ts'
import { validateAffectedTestPaths } from './focused-test-paths.ts'

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
  expect(() => validateAffectedTestPaths(['escape.test.ts'], tree)).toThrow(
    'focused test path "escape.test.ts" resolves outside the run worktree',
  )
})

test('a selection past the worker bound is validated without the count', () => {
  const tree = directory('focused-tree-')
  const selected = Array.from({ length: FOCUSED_TEST_MAX_PATHS + 1 }, (_, index) => {
    const name = `selected-${index}.test.ts`
    writeFileSync(join(tree, name), '')
    return name
  })
  expect(validateAffectedTestPaths(selected, tree)).toHaveLength(selected.length)
  expect(() => validateAffectedTestPaths([...selected, 'missing.test.ts'], tree)).toThrow(
    'focused test path "missing.test.ts" does not exist',
  )
})
