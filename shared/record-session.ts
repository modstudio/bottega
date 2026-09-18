import { PLATFORM_NAME } from './brand.ts'
import {
  deleteKeychainItem,
  readKeychainItem,
  type SecurityRunner,
  writeKeychainItem,
} from './keychain.ts'

export type { SecurityRunner } from './keychain.ts'

const SERVICE = `${PLATFORM_NAME}-record-session`
const ACCOUNT = 'record'
export function readRecordSessionToken(runner?: SecurityRunner): string | null {
  return readKeychainItem(SERVICE, ACCOUNT, runner)
}

export function writeRecordSessionToken(token: string, runner?: SecurityRunner): void {
  writeKeychainItem(SERVICE, ACCOUNT, token, runner)
}

export function clearRecordSessionToken(runner?: SecurityRunner): void {
  deleteKeychainItem(SERVICE, ACCOUNT, runner)
}
