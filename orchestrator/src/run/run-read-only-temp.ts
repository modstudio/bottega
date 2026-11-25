// concern: read-only run temp
/** Prepares the private temp directory required by a read-only run. */

import { lstatSync, mkdirSync } from 'node:fs'
import { runTempDir } from '../run-owned-paths.ts'

export function prepareReadOnlyRunTemp(writesJob: boolean, runtimeDir: string): void {
  if (writesJob) return
  const path = runTempDir(runtimeDir)
  try {
    const stat = lstatSync(path)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(
        `run temp path ${path} is not a real directory; remedy: remove it and retry the run`,
      )
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    mkdirSync(path, { recursive: true, mode: 0o700 })
  }
}
