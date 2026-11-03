import { PLATFORM_SLUG } from './brand.ts'

export const KEYSTORE_ENV = `${PLATFORM_SLUG.toUpperCase()}_KEYSTORE`

/** Select the explicitly requested file store, or the default keychain store. */
export function decideKeyStore(requested: string | undefined): 'file' | 'keychain' {
  if (requested === 'file') return 'file'
  if (requested !== undefined) {
    throw new Error(`${KEYSTORE_ENV} must be 'file' when set`)
  }
  return 'keychain'
}
