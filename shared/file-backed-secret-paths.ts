import { join } from 'node:path'
import { type ConfigEnvironment, resolveConfigRoot } from './config-directory.ts'
import { hubLoginTokenDirectory, recordSessionDirectory } from './state-directory.ts'

export function machineKeyFilePath(environment: ConfigEnvironment): string {
  return join(resolveConfigRoot(environment), 'machine-key')
}

/** Every path that may hold a secret in a file, staging included; every sandbox denies them all. */
export function fileBackedSecretPaths(environment: ConfigEnvironment): string[] {
  return [
    hubLoginTokenDirectory(environment),
    machineKeyFilePath(environment),
    recordSessionDirectory(environment),
  ]
}
