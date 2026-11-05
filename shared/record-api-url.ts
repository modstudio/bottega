import { RECORD_API_ORIGIN } from './brand.ts'
import type { ConfigEnvironment } from './config-directory.ts'
import { readEnvValues } from './env-values.ts'

/** Resolve only an endpoint explicitly chosen by this install. */
function configuredRecordApiUrl(env: ConfigEnvironment = process.env): string | undefined {
  return readEnvValues(['BOTTEGA_RECORD_API_URL'], env).BOTTEGA_RECORD_API_URL
}

/** Resolve the address to call, using the production record when none was configured. */
export function resolveRecordApiUrl(env: ConfigEnvironment = process.env): string {
  return configuredRecordApiUrl(env)?.trim() || RECORD_API_ORIGIN
}

/** Whether a non-empty hosted record endpoint is configured. */
export function recordApiConfigured(env: ConfigEnvironment = process.env): boolean {
  return Boolean(configuredRecordApiUrl(env)?.trim())
}
