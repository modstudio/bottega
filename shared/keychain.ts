type SecurityResult = {
  exitCode: number
  stdout: Uint8Array
  stderr: Uint8Array
}

export type SecurityRunner = (argv: string[], stdin?: Uint8Array) => SecurityResult

const MISSING_ITEM_EXIT_CODE = 44
const decoder = new TextDecoder()
const encoder = new TextEncoder()
const RUNNER_KEY = Symbol.for('orch.security-runner')

function runSecurity(argv: string[], stdin?: Uint8Array): SecurityResult {
  const holder = globalThis as typeof globalThis & { [RUNNER_KEY]?: SecurityRunner }
  const injected = holder[RUNNER_KEY]
  if (injected) return injected(argv, stdin)
  if (process.env.NODE_ENV === 'test')
    throw new Error('keychain access requires an injected security runner in tests')
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

export function readKeychainItem(
  service: string,
  account: string,
  runner: SecurityRunner = runSecurity,
): string | null {
  const result = runner(['security', 'find-generic-password', '-a', account, '-s', service, '-w'])
  if (result.exitCode === MISSING_ITEM_EXIT_CODE) return null
  if (result.exitCode !== 0) throw failure('find-generic-password', result)
  return decoder.decode(result.stdout).trim() || null
}

export function writeKeychainItem(
  service: string,
  account: string,
  value: string,
  runner: SecurityRunner = runSecurity,
): void {
  const result = runner(
    ['security', 'add-generic-password', '-U', '-a', account, '-s', service, '-w'],
    encoder.encode(`${value}\n${value}\n`),
  )
  if (result.exitCode !== 0) throw failure('add-generic-password', result, value)
  if (readKeychainItem(service, account, runner) !== value)
    throw new Error('security add-generic-password verification failed: stored value did not match')
}

export function deleteKeychainItem(
  service: string,
  account: string,
  runner: SecurityRunner = runSecurity,
): void {
  const result = runner(['security', 'delete-generic-password', '-a', account, '-s', service])
  if (result.exitCode === MISSING_ITEM_EXIT_CODE) return
  if (result.exitCode !== 0) throw failure('delete-generic-password', result)
}
