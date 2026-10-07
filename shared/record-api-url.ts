import type { ConfigEnvironment } from './config-directory.ts'
import { readEnvValues } from './env-source.ts'

/** Resolve the hosted record endpoint at use time. */
export function resolveRecordApiUrl(env: ConfigEnvironment = process.env): string | undefined {
  return readEnvValues(['ORCH_RECORD_API_URL'], env).ORCH_RECORD_API_URL
}
