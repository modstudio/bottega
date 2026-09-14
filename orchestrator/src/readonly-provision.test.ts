import { afterEach, expect, test } from 'bun:test'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { provisionReadOnlyTree, validateReadonlyProvision } from './readonly-provision.ts'

const roots: string[] = []
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'orch-readonly-provision-'))
  roots.push(root)
  const main = join(root, 'main')
  const tree = join(root, 'tree')
  mkdirSync(main); mkdirSync(tree)
  return { main, tree }
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

test('link creates a real directory whose entries are symlinks', () => {
  const { main, tree } = fixture()
  mkdirSync(join(main, 'node_modules'))
  writeFileSync(join(main, 'node_modules', '.hidden'), 'hidden')
  writeFileSync(join(main, 'node_modules', 'package'), 'contents')

  provisionReadOnlyTree(main, tree, [{ path: 'node_modules', method: 'link' }])

  expect(lstatSync(join(tree, 'node_modules')).isDirectory()).toBe(true)
  expect(lstatSync(join(tree, 'node_modules', 'package')).isSymbolicLink()).toBe(true)
  expect(lstatSync(join(tree, 'node_modules', '.hidden')).isSymbolicLink()).toBe(true)
})

test('clone creates a real directory with matching content', () => {
  const { main, tree } = fixture()
  mkdirSync(join(main, 'vendor'))
  writeFileSync(join(main, 'vendor', 'autoload.php'), '<?php')

  provisionReadOnlyTree(main, tree, [{ path: 'vendor', method: 'clone' }])

  expect(lstatSync(join(tree, 'vendor')).isDirectory()).toBe(true)
  expect(lstatSync(join(tree, 'vendor')).isSymbolicLink()).toBe(false)
  expect(readFileSync(join(tree, 'vendor', 'autoload.php'), 'utf8')).toBe('<?php')
})

test('missing source path is skipped', () => {
  const { main, tree } = fixture()
  expect(() => provisionReadOnlyTree(main, tree, [{ path: 'missing', method: 'link' }])).not.toThrow()
  expect(() => lstatSync(join(tree, 'missing'))).toThrow()
})

test('existing target is left alone', () => {
  const { main, tree } = fixture()
  mkdirSync(join(main, 'vendor')); mkdirSync(join(tree, 'vendor'))
  writeFileSync(join(main, 'vendor', 'source'), 'source')
  writeFileSync(join(tree, 'vendor', 'kept'), 'kept')

  provisionReadOnlyTree(main, tree, [{ path: 'vendor', method: 'clone' }])

  expect(readFileSync(join(tree, 'vendor', 'kept'), 'utf8')).toBe('kept')
  expect(() => lstatSync(join(tree, 'vendor', 'source'))).toThrow()
})

test('validation refuses malformed readonly provision declarations', () => {
  expect(validateReadonlyProvision([{ path: 'vendor', method: 'copy' }]))
    .toEqual(["worktree.readonly_provision method must be 'link' or 'clone'"])
  expect(validateReadonlyProvision([{ path: '/vendor', method: 'clone' }]))
    .toEqual(['worktree.readonly_provision path must be a non-empty relative path without ..'])
  expect(validateReadonlyProvision([{ path: '../vendor', method: 'link' }]))
    .toEqual(['worktree.readonly_provision path must be a non-empty relative path without ..'])
  expect(validateReadonlyProvision({ path: 'vendor', method: 'clone' }))
    .toEqual(['worktree.readonly_provision must be an array'])
})
