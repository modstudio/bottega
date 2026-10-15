// concern: focused-test-files
/** No-follow, exclusive file operations for the worker-writable focused-test transport. */

import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'

const CREATE_FLAGS =
  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW

export function createFocusedTestFile(path: string): number {
  return openSync(path, CREATE_FLAGS, 0o600)
}

export function writeFocusedTestFileExclusive(path: string, value: string): void {
  const fd = createFocusedTestFile(path)
  try {
    writeFileSync(fd, value)
  } finally {
    closeSync(fd)
  }
}

export function writeFocusedTestFileAtomic(path: string, value: string): void {
  const temporary = `${path}.tmp`
  let fd: number | null = null
  try {
    fd = createFocusedTestFile(temporary)
    writeFileSync(fd, value)
    closeSync(fd)
    fd = null
    renameSync(temporary, path)
  } catch (error) {
    if (fd !== null) closeSync(fd)
    rmSync(temporary, { force: true })
    throw error
  }
}

export function readFocusedTestRegularFile(path: string): string {
  if (!lstatSync(path).isFile())
    throw new Error(`focused test transport file is not regular: ${path}`)
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    if (!fstatSync(fd).isFile()) {
      throw new Error(`focused test transport file is not regular: ${path}`)
    }
    return readFileSync(fd, 'utf8')
  } finally {
    closeSync(fd)
  }
}
