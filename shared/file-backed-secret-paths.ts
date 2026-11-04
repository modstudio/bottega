import { readFileSync, type Stats, statSync } from 'node:fs'
import {
  type ConfigEnvironment,
  machineKeyFilePath,
  revokedMachineKeyDirectory,
} from './config-directory.ts'
import { hubLoginTokenDirectory, recordSessionDirectory } from './state-directory.ts'

/** Every path that may hold a secret in a file; directories are denied whole, staging included. */
export function fileBackedSecretPaths(environment: ConfigEnvironment): string[] {
  return [
    hubLoginTokenDirectory(environment),
    machineKeyFilePath(environment),
    revokedMachineKeyDirectory(environment),
    recordSessionDirectory(environment),
  ]
}

/** Read a file-held secret, or null when absent; refuse anything but an owner-only regular file. */
export function readOwnerOnlySecretFile(path: string, noun: string): string | null {
  let stat: Stats
  try {
    stat = statSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) {
    throw new Error(`refusing ${noun} ${path}: file permissions must be no wider than 0600`)
  }
  return readFileSync(path, 'utf8')
}
