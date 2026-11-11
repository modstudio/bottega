import type { ConfigEnvironment } from './config-directory.ts'
import { KEYSTORE_ENV, readMachineValue } from './machine-config.ts'

export { KEYSTORE_ENV } from './machine-config.ts'

/** Select the environment, machine-file, or default keystore choice. */
export function decideKeyStore(
  environment: ConfigEnvironment = process.env,
): 'file' | 'keychain' {
  return readMachineValue('machine.keystore', environment) as 'file' | 'keychain'
}
