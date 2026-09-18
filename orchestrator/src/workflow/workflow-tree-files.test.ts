import { afterEach, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyWorkflowTreePlan, collectWorkflowTree } from './workflow-tree-files.ts'

const roots: string[] = []
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'orch-workflow-tree-files-'))
  roots.push(root)
  const tree = join(root, 'tree')
  mkdirSync(join(tree, 'workflows'), { recursive: true })
  return { root, tree, outside: join(root, 'outside.md') }
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test('writing a stub creates only the command directory', () => {
  const { tree } = fixture()
  applyWorkflowTreePlan(tree, {
    writes: [{ path: '.claude/commands/ship.md', body: 'stub\n' }],
    deletes: [],
  })

  expect(readFileSync(join(tree, '.claude', 'commands', 'ship.md'), 'utf8')).toBe('stub\n')
  expect(existsSync(join(tree, '.agents', 'workflows'))).toBe(false)
})

test('a symlinked steps directory is refused and the file outside the tree is unchanged', () => {
  const { tree, outside } = fixture()
  writeFileSync(outside, 'KEEP\n')
  const steps = join(tree, '..', 'outside-steps')
  mkdirSync(steps)
  writeFileSync(join(steps, 'verify.md'), 'KEEP\n')
  symlinkSync(steps, join(tree, 'workflows', 'steps'))

  expect(() => collectWorkflowTree(tree)).toThrow(
    `refusing ${join(tree, 'workflows', 'steps')}: not a real directory`,
  )
  expect(() =>
    applyWorkflowTreePlan(tree, {
      writes: [{ path: 'workflows/steps/verify.md', body: 'ATTACK\n' }],
      deletes: [],
    }),
  ).toThrow(`refusing ${join(tree, 'workflows', 'steps')}: not a real directory`)
  expect(readFileSync(join(steps, 'verify.md'), 'utf8')).toBe('KEEP\n')
  expect(readFileSync(outside, 'utf8')).toBe('KEEP\n')
})

test('a symlinked step file is refused and the file outside the tree is unchanged', () => {
  const { tree, outside } = fixture()
  writeFileSync(outside, 'KEEP\n')
  mkdirSync(join(tree, 'workflows', 'steps'))
  writeFileSync(join(tree, 'workflows', 'steps', 'keep.md'), 'ORIGINAL\n')
  symlinkSync(outside, join(tree, 'workflows', 'steps', 'verify.md'))

  expect(() => collectWorkflowTree(tree)).toThrow(
    `refusing ${join(tree, 'workflows', 'steps', 'verify.md')}: not a regular file`,
  )
  expect(() =>
    applyWorkflowTreePlan(tree, {
      writes: [
        { path: 'workflows/steps/keep.md', body: 'CHANGED\n' },
        { path: 'workflows/steps/verify.md', body: 'ATTACK\n' },
      ],
      deletes: [],
    }),
  ).toThrow(`refusing ${join(tree, 'workflows', 'steps', 'verify.md')}: existing path is a symlink`)
  expect(() =>
    applyWorkflowTreePlan(tree, {
      writes: [],
      deletes: ['workflows/steps/keep.md', 'workflows/steps/verify.md'],
    }),
  ).toThrow(`refusing ${join(tree, 'workflows', 'steps', 'verify.md')}: existing path is a symlink`)
  expect(readFileSync(outside, 'utf8')).toBe('KEEP\n')
  expect(readFileSync(join(tree, 'workflows', 'steps', 'keep.md'), 'utf8')).toBe('ORIGINAL\n')
})
