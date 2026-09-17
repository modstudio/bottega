import { PLATFORM_NAME } from './brand.ts'

const SERVICE = `${PLATFORM_NAME}-record-session`
const ACCOUNT = 'record'
const MISSING_ITEM_EXIT_CODE = 44

type SecurityResult = {
  exitCode: number
  stdout: Uint8Array
  stderr: Uint8Array
}

export type SecurityRunner = (argv: string[], stdin?: Uint8Array) => SecurityResult

const decoder = new TextDecoder()
const encoder = new TextEncoder()

function runSecurity(argv: string[], stdin?: Uint8Array): SecurityResult {
  if (process.env.NODE_ENV === 'test') {
    throw new Error('record session keychain access requires an injected security runner in tests')
  }
  const result = Bun.spawnSync(argv, {
    ...(stdin ? { stdin } : {}),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }
}

function failure(operation: string, result: SecurityResult, redactedValue?: string): Error {
  let detail = decoder.decode(result.stderr).trim()
  if (redactedValue) detail = detail.replaceAll(redactedValue, '***')
  return new Error(
    `security ${operation} failed with exit code ${result.exitCode}${detail ? `: ${detail}` : ''}`,
  )
}

export function readRecordSessionToken(runner: SecurityRunner = runSecurity): string | null {
  const result = runner(['security', 'find-generic-password', '-a', ACCOUNT, '-s', SERVICE, '-w'])
  if (result.exitCode === MISSING_ITEM_EXIT_CODE) return null
  if (result.exitCode !== 0) throw failure('find-generic-password', result)
  return decoder.decode(result.stdout).trim() || null
}

export function writeRecordSessionToken(token: string, runner: SecurityRunner = runSecurity): void {
  // With -w last and no argv value, macOS security reads the password from its prompt.
  // Supplying that prompt over stdin keeps the bearer out of the process listing.
  const result = runner(
    ['security', 'add-generic-password', '-U', '-a', ACCOUNT, '-s', SERVICE, '-w'],
    encoder.encode(`${token}\n${token}\n`),
  )
  if (result.exitCode !== 0) throw failure('add-generic-password', result, token)
  if (readRecordSessionToken(runner) !== token) {
    throw new Error('security add-generic-password verification failed: stored value did not match')
  }
}

export function clearRecordSessionToken(runner: SecurityRunner = runSecurity): void {
  const result = runner(['security', 'delete-generic-password', '-a', ACCOUNT, '-s', SERVICE])
  if (result.exitCode === MISSING_ITEM_EXIT_CODE) return
  if (result.exitCode !== 0) throw failure('delete-generic-password', result)
}
