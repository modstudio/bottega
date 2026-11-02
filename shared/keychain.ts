type SecurityResult = {
  exitCode: number
  stdout: Uint8Array
  stderr: Uint8Array
}

type RunnerEnvironment = Record<string, string | undefined>

export type SecurityRunner = (
  argv: string[],
  stdin?: Uint8Array,
  env?: RunnerEnvironment,
) => SecurityResult
export type AsyncSecurityRunner = (
  argv: string[],
  stdin?: Uint8Array,
  signal?: AbortSignal,
  env?: RunnerEnvironment,
) => Promise<SecurityResult>

export type SecretFailureKind =
  | 'libsecret-missing'
  | 'no-unlocked-collection'
  | 'no-session-bus'
  | 'other'

type KeychainBackend = 'security' | 'bun-secrets'
type LinuxSecretOperation = 'get' | 'set' | 'delete'

const MISSING_ITEM_EXIT_CODE = 44
const SECRET_FAILURE_EXIT_CODE = 70
const decoder = new TextDecoder()
const encoder = new TextEncoder()
const RUNNER_KEY = Symbol.for('orch.security-runner')
const SECRET_OPERATION_ENV = 'BOTTEGA_SECRET_OPERATION'
const SECRET_SERVICE_ENV = 'BOTTEGA_SECRET_SERVICE'
const SECRET_ACCOUNT_ENV = 'BOTTEGA_SECRET_ACCOUNT'

const LINUX_SECRET_SCRIPT = String.raw`
const operation = process.env.${SECRET_OPERATION_ENV};
const service = process.env.${SECRET_SERVICE_ENV};
const name = process.env.${SECRET_ACCOUNT_ENV};
try {
  if (operation === "get") {
    const value = await Bun.secrets.get({ service, name });
    if (value === null) process.exit(${MISSING_ITEM_EXIT_CODE});
    await Bun.write(Bun.stdout, value);
  } else if (operation === "set") {
    const value = await Bun.stdin.text();
    await Bun.secrets.set({ service, name, value });
  } else if (operation === "delete") {
    if (!(await Bun.secrets.delete({ service, name }))) process.exit(${MISSING_ITEM_EXIT_CODE});
  } else {
    throw new Error("unknown secret operation");
  }
} catch (error) {
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ code, message }));
  process.exit(${SECRET_FAILURE_EXIT_CODE});
}
`.trim()

function injectedRunner(): SecurityRunner | undefined {
  const holder = globalThis as typeof globalThis & { [RUNNER_KEY]?: SecurityRunner }
  return holder[RUNNER_KEY]
}

function runSecurity(argv: string[], stdin?: Uint8Array, env?: RunnerEnvironment): SecurityResult {
  const injected = injectedRunner()
  if (injected) return injected(argv, stdin, env)
  if (process.env.NODE_ENV === 'test')
    throw new Error('keychain access requires an injected security runner in tests')
  const result = Bun.spawnSync(argv, {
    ...(stdin ? { stdin } : {}),
    ...(env ? { env } : {}),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }
}

async function runSecurityAsync(
  argv: string[],
  stdin?: Uint8Array,
  signal?: AbortSignal,
  env?: RunnerEnvironment,
): Promise<SecurityResult> {
  const injected = injectedRunner()
  if (injected) return injected(argv, stdin, env)
  if (process.env.NODE_ENV === 'test')
    throw new Error('keychain access requires an injected security runner in tests')
  const child = Bun.spawn(argv, {
    ...(stdin ? { stdin } : {}),
    ...(env ? { env } : {}),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const abort = () => child.kill()
  signal?.addEventListener('abort', abort, { once: true })
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).bytes(),
      new Response(child.stderr).bytes(),
    ])
    if (signal?.aborted) throw signal.reason
    return { exitCode, stdout, stderr }
  } finally {
    signal?.removeEventListener('abort', abort)
  }
}

function failure(operation: string, result: SecurityResult, redactedValue?: string): Error {
  let detail = decoder.decode(result.stderr).trim()
  if (redactedValue) detail = detail.replaceAll(redactedValue, '***')
  return new Error(
    `security ${operation} failed with exit code ${result.exitCode}${detail ? `: ${detail}` : ''}`,
  )
}

export function classifySecretFailure(code: string, message: string): SecretFailureKind {
  if (code === 'ERR_SECRETS_PLATFORM_ERROR' && message.includes('libsecret not available'))
    return 'libsecret-missing'
  if (message.includes('/org/freedesktop/secrets/collection/login')) return 'no-unlocked-collection'
  if (
    /cannot autolaunch d-bus|dbus_session_bus_address|failed to connect to socket|(?:d-bus|dbus).*(?:connect|session bus)/i.test(
      message,
    )
  )
    return 'no-session-bus'
  return 'other'
}

export function decideKeychainBackend(platform: string): KeychainBackend {
  if (platform === 'darwin') return 'security'
  if (platform === 'linux') return 'bun-secrets'
  throw new Error(`keychain storage is unsupported on platform ${platform}`)
}

function linuxEnvironment(
  operation: LinuxSecretOperation,
  service: string,
  account: string,
): RunnerEnvironment {
  return {
    ...process.env,
    BUN_BE_BUN: '1',
    [SECRET_OPERATION_ENV]: operation,
    [SECRET_SERVICE_ENV]: service,
    [SECRET_ACCOUNT_ENV]: account,
  }
}

function linuxArgv(): string[] {
  return [process.execPath, '-e', LINUX_SECRET_SCRIPT]
}

function parseSecretFailure(result: SecurityResult): { code: string; message: string } {
  const detail = decoder.decode(result.stderr).trim()
  try {
    const parsed = JSON.parse(detail) as { code?: unknown; message?: unknown }
    return {
      code: typeof parsed.code === 'string' ? parsed.code : '',
      message: typeof parsed.message === 'string' ? parsed.message : detail,
    }
  } catch {
    return { code: '', message: detail }
  }
}

function secretFailure(
  operation: LinuxSecretOperation,
  result: SecurityResult,
  redactedValue?: string,
): Error {
  const parsed = parseSecretFailure(result)
  const code = parsed.code
  const message = redactedValue ? parsed.message.replaceAll(redactedValue, '***') : parsed.message
  const kind = classifySecretFailure(code, message)
  if (kind === 'libsecret-missing') {
    return new Error(
      `Bun.secrets ${operation} refused: libsecret and a Secret Service keyring are unavailable; install libsecret-1-0 and gnome-keyring`,
    )
  }
  if (kind === 'no-unlocked-collection') {
    return new Error(
      `Bun.secrets ${operation} refused: no unlocked login keyring is available; start and unlock it with gnome-keyring-daemon --replace --unlock --components=secrets --daemonize, providing the password on stdin`,
    )
  }
  if (kind === 'no-session-bus') {
    return new Error(
      `Bun.secrets ${operation} refused: no user D-Bus session is reachable; run inside a user D-Bus session`,
    )
  }
  return new Error(
    `Bun.secrets ${operation} failed with exit code ${result.exitCode}${message ? `: ${message}` : ''}`,
  )
}

function linuxResult(
  operation: LinuxSecretOperation,
  result: SecurityResult,
  redactedValue?: string,
): string | null {
  if (result.exitCode === MISSING_ITEM_EXIT_CODE) return null
  if (result.exitCode !== 0) throw secretFailure(operation, result, redactedValue)
  return decoder.decode(result.stdout).trim() || null
}

export function readLinuxKeychainItem(
  service: string,
  account: string,
  runner: SecurityRunner = runSecurity,
): string | null {
  return linuxResult(
    'get',
    runner(linuxArgv(), undefined, linuxEnvironment('get', service, account)),
  )
}

async function readLinuxKeychainItemAsync(
  service: string,
  account: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const injected = injectedRunner()
  if (injected) return readLinuxKeychainItem(service, account, injected)
  if (signal?.aborted) throw signal.reason
  let abort: (() => void) | undefined
  const aborted = new Promise<never>((_, reject) => {
    abort = () => reject(signal?.reason)
    signal?.addEventListener('abort', abort, { once: true })
  })
  try {
    return await Promise.race([Bun.secrets.get({ service, name: account }), aborted])
  } catch (error) {
    if (signal?.aborted) throw signal.reason
    const candidate = error as { code?: unknown; message?: unknown }
    const code = typeof candidate.code === 'string' ? candidate.code : ''
    const message = typeof candidate.message === 'string' ? candidate.message : String(error)
    throw secretFailure('get', {
      exitCode: SECRET_FAILURE_EXIT_CODE,
      stdout: new Uint8Array(),
      stderr: encoder.encode(JSON.stringify({ code, message })),
    })
  } finally {
    if (abort) signal?.removeEventListener('abort', abort)
  }
}

export function writeLinuxKeychainItem(
  service: string,
  account: string,
  value: string,
  runner: SecurityRunner = runSecurity,
): void {
  const result = runner(
    linuxArgv(),
    encoder.encode(value),
    linuxEnvironment('set', service, account),
  )
  linuxResult('set', result, value)
  if (readLinuxKeychainItem(service, account, runner) !== value)
    throw new Error('Bun.secrets set verification failed: stored value did not match')
}

export function deleteLinuxKeychainItem(
  service: string,
  account: string,
  runner: SecurityRunner = runSecurity,
): void {
  linuxResult(
    'delete',
    runner(linuxArgv(), undefined, linuxEnvironment('delete', service, account)),
  )
}

export function readKeychainItem(
  service: string,
  account: string,
  runner: SecurityRunner = runSecurity,
): string | null {
  if (decideKeychainBackend(process.platform) === 'bun-secrets')
    return readLinuxKeychainItem(service, account, runner)
  const result = runner(['security', 'find-generic-password', '-a', account, '-s', service, '-w'])
  if (result.exitCode === MISSING_ITEM_EXIT_CODE) return null
  if (result.exitCode !== 0) throw failure('find-generic-password', result)
  return decoder.decode(result.stdout).trim() || null
}

export async function readKeychainItemAsync(
  service: string,
  account: string,
  signal?: AbortSignal,
  runner: AsyncSecurityRunner = runSecurityAsync,
): Promise<string | null> {
  if (decideKeychainBackend(process.platform) === 'bun-secrets')
    return readLinuxKeychainItemAsync(service, account, signal)
  const result = await runner(
    ['security', 'find-generic-password', '-a', account, '-s', service, '-w'],
    undefined,
    signal,
  )
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
  if (decideKeychainBackend(process.platform) === 'bun-secrets') {
    writeLinuxKeychainItem(service, account, value, runner)
    return
  }
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
  if (decideKeychainBackend(process.platform) === 'bun-secrets') {
    deleteLinuxKeychainItem(service, account, runner)
    return
  }
  const result = runner(['security', 'delete-generic-password', '-a', account, '-s', service])
  if (result.exitCode === MISSING_ITEM_EXIT_CODE) return
  if (result.exitCode !== 0) throw failure('delete-generic-password', result)
}
