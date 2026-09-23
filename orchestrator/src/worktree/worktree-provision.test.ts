import { afterEach, expect, test } from 'bun:test'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { provisionWorktree, validateReadonlyProvision } from './worktree-provision.ts'

const roots: string[] = []
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'orch-readonly-provision-'))
  roots.push(root)
  const main = join(root, 'main')
  const tree = join(root, 'tree')
  mkdirSync(main)
  mkdirSync(tree)
  return { main, tree }
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test('link creates a real directory whose entries are symlinks', () => {
  const { main, tree } = fixture()
  mkdirSync(join(main, 'node_modules'))
  writeFileSync(join(main, 'node_modules', '.hidden'), 'hidden')
  writeFileSync(join(main, 'node_modules', 'package'), 'contents')

  provisionWorktree(main, tree, [{ path: 'node_modules', method: 'link' }])

  expect(lstatSync(join(tree, 'node_modules')).isDirectory()).toBe(true)
  expect(lstatSync(join(tree, 'node_modules', 'package')).isSymbolicLink()).toBe(true)
  expect(lstatSync(join(tree, 'node_modules', '.hidden')).isSymbolicLink()).toBe(true)
})

test('missing source path is skipped and reported', () => {
  const { main, tree } = fixture()
  expect(provisionWorktree(main, tree, [{ path: 'missing', method: 'link' }])).toEqual([
    { path: 'missing', reason: 'missing source' },
  ])
  expect(() => lstatSync(join(tree, 'missing'))).toThrow()
})

test('existing target is left alone', () => {
  const { main, tree } = fixture()
  mkdirSync(join(main, 'vendor'))
  mkdirSync(join(tree, 'vendor'))
  writeFileSync(join(main, 'vendor', 'source'), 'source')
  writeFileSync(join(tree, 'vendor', 'kept'), 'kept')

  provisionWorktree(main, tree, [{ path: 'vendor', method: 'clone' }])

  expect(readFileSync(join(tree, 'vendor', 'kept'), 'utf8')).toBe('kept')
  expect(() => lstatSync(join(tree, 'vendor', 'source'))).toThrow()
})

test('validation refuses malformed readonly provision declarations', () => {
  expect(validateReadonlyProvision([{ path: 'vendor', method: 'copy' }])).toEqual([
    "worktree.readonly_provision method must be 'link' or 'clone'",
  ])
  expect(validateReadonlyProvision([{ path: '/vendor', method: 'clone' }])).toEqual([
    'worktree.readonly_provision path must be a non-empty relative path without ..',
  ])
  expect(validateReadonlyProvision([{ path: '../vendor', method: 'link' }])).toEqual([
    'worktree.readonly_provision path must be a non-empty relative path without ..',
  ])
  expect(validateReadonlyProvision({ path: 'vendor', method: 'clone' })).toEqual([
    'worktree.readonly_provision must be an array',
  ])
  expect(
    validateReadonlyProvision([
      { path: 'vendor', method: 'clone' },
      { path: 'vendor', method: 'link' },
    ]),
  ).toEqual(['worktree.readonly_provision path must be unique: "vendor"'])
})

test('a path through a symlinked ancestor that leaves the tree is refused and creates nothing outside', () => {
  const { main, tree } = fixture()
  mkdirSync(join(main, 'deps', 'vendor'), { recursive: true })
  writeFileSync(join(main, 'deps', 'vendor', 'autoload.php'), '<?php')
  const outside = join(tree, '..', 'outside')
  mkdirSync(outside)
  symlinkSync(outside, join(tree, 'deps'))

  expect(() => provisionWorktree(main, tree, [{ path: 'deps/vendor', method: 'link' }])).toThrow(
    'resolves outside the tree',
  )
  expect(() => lstatSync(join(outside, 'vendor'))).toThrow()
})
