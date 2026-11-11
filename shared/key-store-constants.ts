import { PLATFORM_SLUG } from './brand.ts'

export const KEYSTORE_ENV = `${PLATFORM_SLUG.toUpperCase()}_KEYSTORE`
export const KEYSTORE_VALUES = ['keychain', 'file'] as const
export type Keystore = (typeof KEYSTORE_VALUES)[number]
export const KEYSTORE_DEFAULT: Keystore = 'keychain'
