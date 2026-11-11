import type { ConfigEnvironment } from './config-directory.ts'
import type { Keystore } from './key-store-constants.ts'
import { readMachineValue } from './machine-config.ts'

/** Select the environment, machine-file, or default keystore choice. */
export function decideKeyStore(environment: ConfigEnvironment = process.env): Keystore {
  return readMachineValue('machine.keystore', environment) as Keystore
}
