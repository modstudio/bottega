// concern: record-use
/** Owns hosted-record discovery and the local binding file. Must not know CLI grammar or authentication. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { type ConfigEnvironment, resolvePlatformEnvFile } from '../../../shared/config-directory.ts'

export type RecordClientAddresses = {
  recordApiUrl: string
  hubHostedUrl: string
}
type RecordUseRequest = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

function validHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function discoveredAddresses(body: unknown): RecordClientAddresses {
  if (
    typeof body !== 'object' ||
    body === null ||
    !validHttpUrl(Reflect.get(body, 'recordApiUrl')) ||
    !validHttpUrl(Reflect.get(body, 'hubHostedUrl'))
  ) {
    throw new Error(
      'the discovery response did not contain valid recordApiUrl and hubHostedUrl addresses',
    )
  }
  return {
    recordApiUrl: Reflect.get(body, 'recordApiUrl'),
    hubHostedUrl: Reflect.get(body, 'hubHostedUrl'),
  }
}

function lineEnding(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n'
}

/** Replace only the two hosted-address assignments, retaining all unrelated bytes. */
export function rewriteRecordBindingEnv(text: string, addresses: RecordClientAddresses): string {
  const values = new Map([
    ['ORCH_RECORD_API_URL', addresses.recordApiUrl],
    ['HUB_HOSTED_URL', addresses.hubHostedUrl],
  ])
  const seen = new Set<string>()
  const rewritten = text.replace(
    /(^|\r?\n)([ \t]*(?:export[ \t]+)?)(ORCH_RECORD_API_URL|HUB_HOSTED_URL)[ \t]*=[^\r\n]*/g,
    (_line, boundary: string, prefix: string, key: string) => {
      seen.add(key)
      return `${boundary}${prefix}${key}=${values.get(key)}`
    },
  )
  const missing = [...values].filter(([key]) => !seen.has(key))
  if (missing.length === 0) return rewritten
  const eol = lineEnding(text)
  const separator = rewritten.length === 0 || rewritten.endsWith('\n') ? '' : eol
  return `${rewritten}${separator}${missing.map(([key, value]) => `${key}=${value}`).join(eol)}${eol}`
}

function readBindingFile(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

export async function useHostedRecord(
  address: string,
  presentation: { log(message: string): void; warn(message: string): void },
  environment: ConfigEnvironment = process.env,
  request: RecordUseRequest = fetch,
): Promise<void> {
  const discoveryUrl = `${address.replace(/\/+$/, '')}/client-config`
  let response: Response
  try {
    response = await request(discoveryUrl)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`cannot use hosted record at ${address}: ${reason}`)
  }
  if (!response.ok) {
    throw new Error(
      `cannot use hosted record at ${address}: discovery returned ${response.status} ${response.statusText}`,
    )
  }
  let addresses: RecordClientAddresses
  try {
    addresses = discoveredAddresses(await response.json())
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`cannot use hosted record at ${address}: ${reason}`)
  }

  const path = resolvePlatformEnvFile(environment)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, rewriteRecordBindingEnv(readBindingFile(path), addresses))
  presentation.log(`wrote ORCH_RECORD_API_URL=${addresses.recordApiUrl} to ${path}`)
  presentation.log(`wrote HUB_HOSTED_URL=${addresses.hubHostedUrl} to ${path}`)
  for (const [key, value] of [
    ['ORCH_RECORD_API_URL', addresses.recordApiUrl],
    ['HUB_HOSTED_URL', addresses.hubHostedUrl],
  ] as const) {
    if (environment[key] !== undefined && environment[key] !== value) {
      presentation.warn(`${key}=${environment[key]} from the environment wins for this shell`)
    }
  }
  presentation.log(`next: ${PLATFORM_SLUG} record sign-in --email <email>`)
}
