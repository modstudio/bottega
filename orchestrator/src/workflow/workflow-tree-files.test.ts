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
  mkdirSync(join(tree, '.agents'), { recursive: true })
  return { root, tree, outside: join(root, 'outside.md') }
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test('writing a workflow creates its mirror directory', () => {
  const { tree } = fixture()
  applyWorkflowTreePlan(tree, {
    writes: [{ path: '.agents/workflows/flow.md', body: 'workflow\n' }],
    deletes: [],
  })

  expect(readFileSync(join(tree, '.agents', 'workflows', 'flow.md'), 'utf8')).toBe('workflow\n')
  expect(existsSync(join(tree, '.claude', 'commands'))).toBe(false)
})

test('a symlinked steps directory is refused and the file outside the tree is unchanged', () => {
  const { tree, outside } = fixture()
  writeFileSync(outside, 'KEEP\n')
  const steps = join(tree, '..', 'outside-steps')
  mkdirSync(steps)
  writeFileSync(join(steps, 'verify.md'), 'KEEP\n')
  symlinkSync(steps, join(tree, '.agents', 'workflow-steps'))

  expect(() => collectWorkflowTree(tree)).toThrow(
    `refusing ${join(tree, '.agents', 'workflow-steps')}: not a real directory`,
  )
  expect(() =>
    applyWorkflowTreePlan(tree, {
      writes: [{ path: '.agents/workflow-steps/verify.md', body: 'ATTACK\n' }],
      deletes: [],
    }),
  ).toThrow(`refusing ${join(tree, '.agents', 'workflow-steps')}: not a real directory`)
  expect(readFileSync(join(steps, 'verify.md'), 'utf8')).toBe('KEEP\n')
  expect(readFileSync(outside, 'utf8')).toBe('KEEP\n')
})

test('a symlinked step file is refused and the file outside the tree is unchanged', () => {
  const { tree, outside } = fixture()
  writeFileSync(outside, 'KEEP\n')
  mkdirSync(join(tree, '.agents', 'workflow-steps'))
  writeFileSync(join(tree, '.agents', 'workflow-steps', 'keep.md'), 'ORIGINAL\n')
  symlinkSync(outside, join(tree, '.agents', 'workflow-steps', 'verify.md'))

  expect(() => collectWorkflowTree(tree)).toThrow(
    `refusing ${join(tree, '.agents', 'workflow-steps', 'verify.md')}: not a regular file`,
  )
  expect(() =>
    applyWorkflowTreePlan(tree, {
      writes: [
        { path: '.agents/workflow-steps/keep.md', body: 'CHANGED\n' },
        { path: '.agents/workflow-steps/verify.md', body: 'ATTACK\n' },
      ],
      deletes: [],
    }),
  ).toThrow(
    `refusing ${join(tree, '.agents', 'workflow-steps', 'verify.md')}: existing path is a symlink`,
  )
  expect(() =>
    applyWorkflowTreePlan(tree, {
      writes: [],
      deletes: ['.agents/workflow-steps/keep.md', '.agents/workflow-steps/verify.md'],
    }),
  ).toThrow(
    `refusing ${join(tree, '.agents', 'workflow-steps', 'verify.md')}: existing path is a symlink`,
  )
  expect(readFileSync(outside, 'utf8')).toBe('KEEP\n')
  expect(readFileSync(join(tree, '.agents', 'workflow-steps', 'keep.md'), 'utf8')).toBe(
    'ORIGINAL\n',
  )
})
