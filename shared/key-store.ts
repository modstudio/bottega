import { MACHINE_KEYSTORE_ENV } from './key-store-constants.ts'
import { readMachineValue } from './machine-config.ts'

export const KEYSTORE_ENV = MACHINE_KEYSTORE_ENV

/** Select the environment, machine-file, or default keystore choice. */
export function decideKeyStore(
  environment: NonNullable<Parameters<typeof readMachineValue>[1]> = process.env,
): 'file' | 'keychain' {
  return readMachineValue('machine.keystore', environment) as 'file' | 'keychain'
}
