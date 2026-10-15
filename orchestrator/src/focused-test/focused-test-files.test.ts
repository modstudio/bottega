import { afterEach, expect, test } from 'bun:test'
import { lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFocusedTestFile, writeFocusedTestFileAtomic } from './focused-test-files.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test('log and result creation never follows worker-planted symlinks', () => {
  const root = mkdtempSync(join(tmpdir(), 'focused-files-'))
  roots.push(root)
  const sentinel = join(root, 'sentinel')
  const log = join(root, 'focused-test-id.log')
  const result = join(root, 'focused-test-result-id.json')
  const resultTemporary = `${result}.tmp`
  writeFileSync(sentinel, 'original')

  symlinkSync(sentinel, log)
  expect(() => createFocusedTestFile(log)).toThrow()
  expect(readFileSync(sentinel, 'utf8')).toBe('original')

  symlinkSync(sentinel, resultTemporary)
  expect(() => writeFocusedTestFileAtomic(result, '{"exitCode":0}')).toThrow()
  expect(readFileSync(sentinel, 'utf8')).toBe('original')

  symlinkSync(sentinel, result)
  writeFocusedTestFileAtomic(result, '{"exitCode":0}')
  expect(lstatSync(result).isFile()).toBe(true)
  expect(readFileSync(result, 'utf8')).toBe('{"exitCode":0}')
  expect(readFileSync(sentinel, 'utf8')).toBe('original')
})
