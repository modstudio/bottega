import { join } from 'node:path'
import { type ConfigEnvironment, resolveConfigRoot } from './config-directory.ts'
import { recordSessionPath } from './state-directory.ts'

export function machineKeyFilePath(environment: ConfigEnvironment): string {
  return join(resolveConfigRoot(environment), 'machine-key')
}

/** Every path that may contain a file-backed secret. */
export function fileBackedSecretPaths(environment: ConfigEnvironment): string[] {
  return [machineKeyFilePath(environment), recordSessionPath(environment)]
}
