import { rmSync, writeFileSync } from 'node:fs'
import { resolvePlatformEnvFile } from '../../shared/config-directory.ts'

/** Configure the record address through the env file prepared by the hub test preload. */
export function configureRecordApiUrl(address = 'https://configured-record.example.test') {
  if (process.env.BOTTEGA_RECORD_API_URL !== undefined) {
    throw new Error('hub test preload must leave BOTTEGA_RECORD_API_URL unset')
  }
  const path = resolvePlatformEnvFile(process.env)
  writeFileSync(path, `BOTTEGA_RECORD_API_URL=${address}\n`)
  return () => rmSync(path, { force: true })
}
