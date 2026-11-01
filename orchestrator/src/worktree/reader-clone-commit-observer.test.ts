import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { dir } from '../../test/fixtures/store.ts'
import {
  readerCloneHasNoUniqueCommits,
  readerCloneSourceRefExclusions,
  readerCloneUniqueCommitCount,
} from './reader-clone-commit-observer.ts'

const cleanupPaths = new Set<string>()

afterEach(() => {
  mock.restore()
  for (const path of cleanupPaths) rmSync(path, { recursive: true, force: true })
  cleanupPaths.clear()
})

function spawnResult(stdout = '', exitCode = 0): ReturnType<typeof Bun.spawnSync> {
  return {
    exitCode,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(''),
    success: exitCode === 0,
    exitedDueToTimeout: false,
  } as ReturnType<typeof Bun.spawnSync>
}

test('reader clone commit observation uses source refs and optional base in their own checkouts', () => {
  const project = join(dir, 'reader-clone-observer-project')
  const clone = join(dir, 'reader-clone-observer-clone')
  cleanupPaths.add(project)
  cleanupPaths.add(clone)
  rmSync(project, { recursive: true, force: true })
  rmSync(clone, { recursive: true, force: true })
  mkdirSync(project, { recursive: true })
  mkdirSync(clone, { recursive: true })
  const calls: Array<{ args: string[]; cwd?: string }> = []
  spyOn(Bun, 'spawnSync').mockImplementation(((command: string[], options?: { cwd?: string }) => {
    const args = command[0] === 'git' ? command.slice(1) : command
    calls.push({ args, cwd: options?.cwd })
    if (args[0] === 'for-each-ref') return spawnResult('source-tip\n')
    if (args[0] === 'rev-list') return spawnResult('0\n')
    return spawnResult('', 1)
  }) as typeof Bun.spawnSync)

  const exclusions = readerCloneSourceRefExclusions(project)
  expect(exclusions).toEqual(['^source-tip'])
  expect(readerCloneHasNoUniqueCommits(clone, exclusions!, 'base-tip')).toBe(true)
  expect(readerCloneHasNoUniqueCommits(clone, exclusions!)).toBe(true)
  expect(readerCloneUniqueCommitCount(clone, project)).toBe(0)

  expect(calls[0]).toEqual({
    cwd: project,
    args: ['for-each-ref', '--format=%(objectname)'],
  })
  expect(calls[1]).toEqual({
    cwd: clone,
    args: ['rev-list', '--count', '--all', '^base-tip', '^source-tip'],
  })
  expect(calls[2]).toEqual({
    cwd: clone,
    args: ['rev-list', '--count', '--all', '^source-tip'],
  })
  expect(calls[3]).toEqual({
    cwd: project,
    args: ['for-each-ref', '--format=%(objectname)'],
  })
  expect(calls[4]).toEqual({
    cwd: clone,
    args: ['rev-list', '--count', '--all', '^source-tip'],
  })
})

test('reader clone commit observation returns null when git inspection fails', () => {
  const project = join(dir, 'reader-clone-observer-failure-project')
  const clone = join(dir, 'reader-clone-observer-failure-clone')
  cleanupPaths.add(project)
  cleanupPaths.add(clone)
  mkdirSync(project, { recursive: true })
  mkdirSync(clone, { recursive: true })
  spyOn(Bun, 'spawnSync').mockImplementation((() => spawnResult('', 1)) as typeof Bun.spawnSync)
  expect(readerCloneUniqueCommitCount(clone, project)).toBeNull()
})
