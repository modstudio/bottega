import { join } from 'node:path'
import { type ConfigEnvironment, resolveConfigRoot } from './config-directory.ts'
import { recordSessionDirectory } from './state-directory.ts'

export function machineKeyFilePath(environment: ConfigEnvironment): string {
  return join(resolveConfigRoot(environment), 'machine-key')
}

/** Every path that may contain a file-backed secret, including a secret's write staging. */
export function fileBackedSecretPaths(environment: ConfigEnvironment): string[] {
  return [machineKeyFilePath(environment), recordSessionDirectory(environment)]
}
