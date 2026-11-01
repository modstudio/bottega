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

test('a commit outside source refs but present in the source object store is not unique', () => {
  const project = join(dir, 'reader-clone-observer-project')
  const clone = join(dir, 'reader-clone-observer-clone')
  cleanupPaths.add(project)
  cleanupPaths.add(clone)
  rmSync(project, { recursive: true, force: true })
  rmSync(clone, { recursive: true, force: true })
  mkdirSync(project, { recursive: true })
  mkdirSync(clone, { recursive: true })
  const calls: Array<{ args: string[]; cwd?: string; stdin?: string }> = []
  const candidate = '1111111111111111111111111111111111111111'
  spyOn(Bun, 'spawnSync').mockImplementation(((
    command: string[],
    options?: { cwd?: string; stdin?: Uint8Array },
  ) => {
    const args = command[0] === 'git' ? command.slice(1) : command
    calls.push({
      args,
      cwd: options?.cwd,
      stdin: options?.stdin ? Buffer.from(options.stdin).toString() : undefined,
    })
    if (args[0] === 'for-each-ref') return spawnResult('source-tip\n')
    if (args[0] === 'rev-list') return spawnResult(`${candidate}\n`)
    if (args[0] === 'cat-file') return spawnResult(`${candidate} commit 123\n`)
    return spawnResult('', 1)
  }) as typeof Bun.spawnSync)

  const exclusions = readerCloneSourceRefExclusions(project)
  expect(exclusions).toEqual(['^source-tip'])
  expect(readerCloneHasNoUniqueCommits(clone, project, exclusions!, 'base-tip')).toBe(true)
  expect(readerCloneHasNoUniqueCommits(clone, project, exclusions!)).toBe(true)
  expect(readerCloneUniqueCommitCount(clone, project)).toBe(0)

  expect(calls[0]).toEqual({
    cwd: project,
    args: ['for-each-ref', '--format=%(objectname)'],
    stdin: undefined,
  })
  expect(calls[1]).toEqual({
    cwd: clone,
    args: ['rev-list', '--all', '^base-tip', '^source-tip'],
    stdin: undefined,
  })
  expect(calls[2]).toEqual({
    cwd: project,
    args: ['cat-file', '--batch-check'],
    stdin: `${candidate}^{commit}\n`,
  })
  expect(calls[3]).toEqual({
    cwd: clone,
    args: ['rev-list', '--all', '^source-tip'],
    stdin: undefined,
  })
  expect(calls[4]).toEqual({
    cwd: project,
    args: ['cat-file', '--batch-check'],
    stdin: `${candidate}^{commit}\n`,
  })
  expect(calls[5]).toEqual({
    cwd: project,
    args: ['for-each-ref', '--format=%(objectname)'],
    stdin: undefined,
  })
  expect(calls[6]).toEqual({
    cwd: clone,
    args: ['rev-list', '--all', '^source-tip'],
    stdin: undefined,
  })
  expect(calls[7]).toEqual({
    cwd: project,
    args: ['cat-file', '--batch-check'],
    stdin: `${candidate}^{commit}\n`,
  })
})

test('a commit absent from the source object store is unique', () => {
  const project = join(dir, 'reader-clone-observer-absent-project')
  const clone = join(dir, 'reader-clone-observer-absent-clone')
  cleanupPaths.add(project)
  cleanupPaths.add(clone)
  mkdirSync(project, { recursive: true })
  mkdirSync(clone, { recursive: true })
  const candidate = '2222222222222222222222222222222222222222'
  spyOn(Bun, 'spawnSync').mockImplementation(((command: string[]) => {
    const args = command[0] === 'git' ? command.slice(1) : command
    if (args[0] === 'for-each-ref') return spawnResult('source-tip\n')
    if (args[0] === 'rev-list') return spawnResult(`${candidate}\n`)
    if (args[0] === 'cat-file') return spawnResult(`${candidate}^{commit} missing\n`)
    return spawnResult('', 1)
  }) as typeof Bun.spawnSync)
  expect(readerCloneUniqueCommitCount(clone, project)).toBe(1)
})

test('reader clone commit observation returns null when cat-file fails', () => {
  const project = join(dir, 'reader-clone-observer-failure-project')
  const clone = join(dir, 'reader-clone-observer-failure-clone')
  cleanupPaths.add(project)
  cleanupPaths.add(clone)
  mkdirSync(project, { recursive: true })
  mkdirSync(clone, { recursive: true })
  const candidate = '3333333333333333333333333333333333333333'
  spyOn(Bun, 'spawnSync').mockImplementation(((command: string[]) => {
    const args = command[0] === 'git' ? command.slice(1) : command
    if (args[0] === 'for-each-ref') return spawnResult('source-tip\n')
    if (args[0] === 'rev-list') return spawnResult(`${candidate}\n`)
    return spawnResult('', 1)
  }) as typeof Bun.spawnSync)
  expect(readerCloneUniqueCommitCount(clone, project)).toBeNull()
})
