import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PLATFORM_NAME } from './brand.ts'
import {
  clearRecordSessionToken,
  probeRecordSessionStore,
  readRecordSessionToken,
  readRecordSessionTokenAsync,
  type SecurityRunner,
  writeRecordSessionToken,
} from './record-session.ts'
import { recordSessionPath, STATE_HOME_ENV } from './state-directory.ts'

const bytes = (value = '') => new TextEncoder().encode(value)
const result = (exitCode: number, stdout = '', stderr = '') => ({
  exitCode,
  stdout: bytes(stdout),
  stderr: bytes(stderr),
})
const service = `${PLATFORM_NAME}-record-session`
const PLATFORM_KEY = Symbol.for('orch.keychain-platform')
const platformHolder = globalThis as typeof globalThis & { [PLATFORM_KEY]?: string }
const originalKeyStore = process.env.BOTTEGA_KEYSTORE
const originalStateHome = process.env[STATE_HOME_ENV]
const originalPlatform = platformHolder[PLATFORM_KEY]
const roots: string[] = []

function restoreEnvironment(): void {
  if (originalKeyStore === undefined) delete process.env.BOTTEGA_KEYSTORE
  else process.env.BOTTEGA_KEYSTORE = originalKeyStore
  if (originalStateHome === undefined) delete process.env[STATE_HOME_ENV]
  else process.env[STATE_HOME_ENV] = originalStateHome
  if (originalPlatform === undefined) delete platformHolder[PLATFORM_KEY]
  else platformHolder[PLATFORM_KEY] = originalPlatform
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
}

afterEach(restoreEnvironment)

describe('record session keychain', () => {
  beforeEach(() => {
    delete process.env.BOTTEGA_KEYSTORE
    platformHolder[PLATFORM_KEY] = 'darwin'
  })

  test('reads and clears the fixed account and branded service', () => {
    const calls: string[][] = []
    const runner: SecurityRunner = (argv) => {
      calls.push(argv)
      return result(0, calls.length === 1 ? 'bearer\n' : '')
    }
    expect(readRecordSessionToken(runner)).toBe('bearer')
    clearRecordSessionToken(runner)
    expect(calls).toEqual([
      ['security', 'find-generic-password', '-a', 'record', '-s', service, '-w'],
      ['security', 'delete-generic-password', '-a', 'record', '-s', service],
    ])
  })

  test('writes the token through stdin rather than argv', () => {
    const token = 'fixture-secret-token'
    const observations: { argv: string[]; stdin?: Uint8Array }[] = []
    writeRecordSessionToken(token, (argv, stdin) => {
      if (argv[1] === '-i') {
        observations.push({ argv, stdin })
        return result(0)
      }
      return result(0, `${token}\n`)
    })
    const observed = observations[0]
    expect(observed?.argv).toEqual(['security', '-i'])
    expect(observed?.argv).not.toContain(token)
    expect(new TextDecoder().decode(observed?.stdin)).toBe(
      `add-generic-password -U -a "record" -s "${service}" -w "${token}"\n`,
    )
  })

  test('rejects a read-back mismatch without exposing the token', () => {
    const token = 'fixture-secret-token'
    let callCount = 0
    let thrown: unknown
    try {
      writeRecordSessionToken(token, () => {
        callCount += 1
        return callCount === 1 ? result(0) : result(0, '')
      })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toBe(
      'security add-generic-password verification failed: stored value did not match',
    )
    expect((thrown as Error).message).not.toContain(token)
  })

  test('returns null only for a missing item and redacts write failures', () => {
    expect(readRecordSessionToken(() => result(44, '', 'not found'))).toBeNull()
    expect(() => readRecordSessionToken(() => result(2, '', 'keychain unavailable'))).toThrow(
      'security find-generic-password failed with exit code 2: keychain unavailable',
    )
    const token = 'fixture-secret-token'
    expect(() => writeRecordSessionToken(token, () => result(3, '', `rejected ${token}`))).toThrow(
      'security add-generic-password failed with exit code 3: rejected ***',
    )
  })

  test('does not create a session file without the opt-in', () => {
    const root = mkdtempSync(join(tmpdir(), 'record-session-keychain-'))
    roots.push(root)
    process.env[STATE_HOME_ENV] = root

    expect(readRecordSessionToken(() => result(0, 'keychain-token\n'))).toBe('keychain-token')
    expect(existsSync(recordSessionPath(process.env))).toBe(false)
  })

  test('probes a distinct key without changing the real session', () => {
    const calls: string[][] = []
    const stored = new Map([['record', 'real-token']])
    const runner: SecurityRunner = (argv, stdin) => {
      calls.push(argv)
      if (argv[1] === '-i') {
        const command = new TextDecoder().decode(stdin)
        const match = command.match(/-a "([^"]+)" .* -w "([^"]+)"/)
        if (match?.[1] && match[2]) stored.set(match[1], match[2])
      }
      if (argv[1] === 'find-generic-password') {
        const account = argv[argv.indexOf('-a') + 1] ?? ''
        return result(0, `${stored.get(account) ?? ''}\n`)
      }
      if (argv[1] === 'delete-generic-password') {
        const account = argv[argv.indexOf('-a') + 1] ?? ''
        stored.delete(account)
      }
      return result(0)
    }

    expect(readRecordSessionToken(runner)).toBe('real-token')
    probeRecordSessionStore(runner)
    expect(readRecordSessionToken(runner)).toBe('real-token')
    expect(calls.some((argv) => argv.includes('record-probe'))).toBe(true)
    expect(
      calls.filter((argv) => argv.includes('record') && !argv.includes('record-probe')),
    ).toHaveLength(2)
  })

  test('a failed probe keeps the store error and adds the file-store remedy', () => {
    expect(() => probeRecordSessionStore(() => result(70, '', 'keychain unavailable'))).toThrow(
      'security add-generic-password failed with exit code 70: keychain unavailable\ncleared by: set BOTTEGA_KEYSTORE=file to keep the record session and the machine key in owner-only files',
    )
  })

  test('adds the file opt-in remedy to Linux keychain failures', () => {
    platformHolder[PLATFORM_KEY] = 'linux'
    expect(() => readRecordSessionToken(() => result(70, '', 'keychain unavailable'))).toThrow(
      '; or set BOTTEGA_KEYSTORE=file to keep the record session and the machine key in owner-only files',
    )
  })
})

describe('file-backed record session', () => {
  let runnerCalls = 0
  const unusedRunner: SecurityRunner = () => {
    runnerCalls += 1
    throw new Error('keychain runner must not be called')
  }

  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), 'record-session-file-'))
    roots.push(root)
    process.env[STATE_HOME_ENV] = root
    process.env.BOTTEGA_KEYSTORE = 'file'
    runnerCalls = 0
  })

  test('writes and reads an owner-only token without calling the keychain', () => {
    writeRecordSessionToken('first-token', unusedRunner)

    const path = recordSessionPath(process.env)
    expect(readRecordSessionToken(unusedRunner)).toBe('first-token')
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700)
    expect(runnerCalls).toBe(0)
  })

  test('atomically replaces an existing token', () => {
    writeRecordSessionToken('first-token', unusedRunner)
    writeRecordSessionToken('second-token', unusedRunner)

    expect(readRecordSessionToken(unusedRunner)).toBe('second-token')
    expect(runnerCalls).toBe(0)
  })

  test('probes a distinct file without changing the real session', () => {
    writeRecordSessionToken('real-token', unusedRunner)
    probeRecordSessionStore(unusedRunner)

    expect(readRecordSessionToken(unusedRunner)).toBe('real-token')
    expect(existsSync(join(dirname(recordSessionPath(process.env)), '.session-probe'))).toBe(false)
    expect(runnerCalls).toBe(0)
  })

  test('clears the token and succeeds when it is already absent', () => {
    writeRecordSessionToken('token', unusedRunner)
    clearRecordSessionToken(unusedRunner)
    clearRecordSessionToken(unusedRunner)

    expect(readRecordSessionToken(unusedRunner)).toBeNull()
    expect(runnerCalls).toBe(0)
  })

  test('refuses a session file with wider permissions and names its path', () => {
    writeRecordSessionToken('token', unusedRunner)
    const path = recordSessionPath(process.env)
    chmodSync(path, 0o644)

    expect(() => readRecordSessionToken(unusedRunner)).toThrow(
      `refusing record session ${path}: file permissions must be no wider than 0600`,
    )
  })

  test('preserves an already-aborted async read', async () => {
    const controller = new AbortController()
    const reason = new Error('read cancelled')
    controller.abort(reason)

    await expect(readRecordSessionTokenAsync(controller.signal)).rejects.toBe(reason)
    expect(runnerCalls).toBe(0)
  })
})
