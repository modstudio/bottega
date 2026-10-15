import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  removalWorkingDirectoryRefusal,
  workingDirectoryIsInsideTree,
} from './removal-working-directory.ts'

test('the real working directory inside a symlinked tree is inside that tree', () => {
  const root = mkdtempSync(join(tmpdir(), 'orch-removal-cwd-'))
  const tree = join(root, 'tree')
  const child = join(tree, 'child')
  const alias = join(root, 'tree-alias')
  try {
    mkdirSync(child, { recursive: true })
    symlinkSync(tree, alias)

    expect(
      workingDirectoryIsInsideTree(realpathSync(join(alias, 'child')), realpathSync(tree)),
    ).toBe(true)
    expect(removalWorkingDirectoryRefusal(alias, root, () => child)).toContain(
      `run this command from the main checkout ${root}`,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a sibling working directory does not block removal', () => {
  expect(workingDirectoryIsInsideTree('/repo/tree-two', '/repo/tree')).toBe(false)
  expect(workingDirectoryIsInsideTree('/repo/tree/child', '/repo/tree')).toBe(true)
})
