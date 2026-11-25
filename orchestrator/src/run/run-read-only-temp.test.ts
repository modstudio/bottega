import { expect, test } from 'bun:test'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareReadOnlyRunTemp } from './run-read-only-temp.ts'

test('read-only run temp is private and refuses paths that are not real directories', () => {
  const root = mkdtempSync(join(tmpdir(), 'run-temp-claim-'))
  try {
    const readerRuntime = join(root, 'reader')
    prepareReadOnlyRunTemp(false, readerRuntime)
    const readerTemp = join(readerRuntime, 'tmp')
    const readerStat = lstatSync(readerTemp)
    expect(readerStat.isDirectory()).toBe(true)
    expect(readerStat.isSymbolicLink()).toBe(false)
    expect(readerStat.mode & 0o777).toBe(0o700)

    const writerRuntime = join(root, 'writer')
    prepareReadOnlyRunTemp(true, writerRuntime)
    expect(existsSync(join(writerRuntime, 'tmp'))).toBe(false)

    const symlinkRuntime = join(root, 'symlink')
    mkdirSync(symlinkRuntime)
    symlinkSync(readerTemp, join(symlinkRuntime, 'tmp'))
    expect(() => prepareReadOnlyRunTemp(false, symlinkRuntime)).toThrow(
      'is not a real directory; remedy: remove it and retry the run',
    )

    const fileRuntime = join(root, 'file')
    mkdirSync(fileRuntime)
    writeFileSync(join(fileRuntime, 'tmp'), '')
    expect(() => prepareReadOnlyRunTemp(false, fileRuntime)).toThrow(
      'is not a real directory; remedy: remove it and retry the run',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
