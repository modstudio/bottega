import type { ConfigEnvironment } from './config-directory.ts'
import { readEnvValues } from './env-values.ts'

/** Resolve the hosted record endpoint at use time. */
export function resolveRecordApiUrl(env: ConfigEnvironment = process.env): string | undefined {
  return readEnvValues(['BOTTEGA_RECORD_API_URL'], env).BOTTEGA_RECORD_API_URL
}
