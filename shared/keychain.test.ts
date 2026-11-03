import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  classifySecretFailure,
  decideKeychainBackend,
  decideNullRead,
  deleteLinuxKeychainItem,
  parseCollectionLocked,
  quoteSecurityInputToken,
  readKeychainItem,
  readKeychainItemAsync,
  readLinuxKeychainItem,
  type SecurityRunner,
  writeKeychainItem,
  writeLinuxKeychainItem,
} from './keychain.ts'

const bytes = (value = '') => new TextEncoder().encode(value)
const result = (exitCode: number, stdout = '', stderr = '') => ({
  exitCode,
  stdout: bytes(stdout),
  stderr: bytes(stderr),
})
const secretError = (code: string, message: string) =>
  result(70, '', JSON.stringify({ code, message }))
const PLATFORM_KEY = Symbol.for('orch.keychain-platform')
const RUNNER_KEY = Symbol.for('orch.security-runner')
const platformHolder = globalThis as typeof globalThis & { [PLATFORM_KEY]?: string }
const runnerHolder = globalThis as typeof globalThis & { [RUNNER_KEY]?: SecurityRunner }
const busctlArgv = [
  'busctl',
  '--user',
  'get-property',
  'org.freedesktop.secrets',
  '/org/freedesktop/secrets/aliases/default',
  'org.freedesktop.Secret.Collection',
  'Locked',
]

describe('secret backend decisions', () => {
  test('selects the platform backend and refuses unsupported platforms', () => {
    expect(decideKeychainBackend('darwin')).toBe('security')
    expect(decideKeychainBackend('linux')).toBe('bun-secrets')
    expect(() => decideKeychainBackend('win32')).toThrow(
      'keychain storage is unsupported on platform win32',
    )
  })
})

describe('Linux secret failure classification', () => {
  test('classifies measured platform failures', () => {
    expect(classifySecretFailure('ERR_SECRETS_PLATFORM_ERROR', 'libsecret not available')).toBe(
      'libsecret-missing',
    )
    expect(
      classifySecretFailure(
        'ERR_SECRETS_PLATFORM_ERROR',
        'Object does not exist at path "/org/freedesktop/secrets/collection/login" (code: 19)',
      ),
    ).toBe('no-unlocked-collection')
    expect(classifySecretFailure('', 'Cannot autolaunch D-Bus without X11 $DISPLAY')).toBe(
      'no-session-bus',
    )
    expect(classifySecretFailure('ERR_SECRETS_PLATFORM_ERROR', 'unexpected failure')).toBe('other')
  })
})

describe('Linux collection lock decisions', () => {
  test('parses the measured busctl boolean output', () => {
    expect(parseCollectionLocked(result(0, 'b true\n'))).toBe(true)
    expect(parseCollectionLocked(result(0, ' b false '))).toBe(false)
    expect(parseCollectionLocked(result(1, '', 'D-Bus unavailable'))).toBeNull()
    expect(parseCollectionLocked(result(0, 'unexpected'))).toBeNull()
  })

  test('distinguishes locked, missing, and unchecked null reads', () => {
    expect(decideNullRead(true)).toBe('locked')
    expect(decideNullRead(false)).toBe('missing')
    expect(decideNullRead(null)).toBe('missing-unchecked')
  })
})

describe('Linux secret runner', () => {
  let originalConsoleError: typeof console.error

  beforeEach(() => {
    originalConsoleError = console.error
  })

  afterEach(() => {
    console.error = originalConsoleError
  })

  test('reads a found value through the Bun child environment', () => {
    const calls: string[][] = []
    const runner: SecurityRunner = (argv, stdin, env) => {
      calls.push(argv)
      expect(argv).toEqual([process.execPath, '-e', expect.any(String)])
      expect(stdin).toBeUndefined()
      expect(env).toMatchObject({
        BUN_BE_BUN: '1',
        BOTTEGA_SECRET_OPERATION: 'get',
        BOTTEGA_SECRET_SERVICE: 'service',
        BOTTEGA_SECRET_ACCOUNT: 'account',
      })
      return result(0, 'stored-value')
    }
    expect(readLinuxKeychainItem('service', 'account', runner)).toBe('stored-value')
    expect(calls).toEqual([[process.execPath, '-e', expect.any(String)]])
  })

  test('refuses a null read when the default collection is locked', () => {
    let calls = 0
    const runner: SecurityRunner = (argv) => {
      calls += 1
      if (calls === 1) return result(44)
      expect(argv).toEqual(busctlArgv)
      return result(0, 'b true')
    }
    expect(() => readLinuxKeychainItem('service', 'account', runner)).toThrow(
      'gnome-keyring-daemon --replace --unlock --components=secrets --daemonize',
    )
  })

  test('returns a missing null read silently when the default collection is unlocked', () => {
    const errors: unknown[][] = []
    console.error = (...args: unknown[]) => errors.push(args)
    const runner: SecurityRunner = (argv) =>
      argv[0] === 'busctl' ? result(0, 'b false') : result(44)

    expect(readLinuxKeychainItem('service', 'account', runner)).toBeNull()
    expect(errors).toEqual([])
  })

  test('reports why the collection lock state could not be checked', () => {
    const errors: unknown[][] = []
    console.error = (...args: unknown[]) => errors.push(args)
    const runner: SecurityRunner = (argv) =>
      argv[0] === 'busctl'
        ? result(1, '', 'Failed to connect to user scope bus\nmore detail')
        : result(44)

    expect(readLinuxKeychainItem('service', 'account', runner)).toBeNull()
    expect(errors).toEqual([
      [
        'keyring lock state could not be checked (Failed to connect to user scope bus); if the login keyring is locked, unlock it with gnome-keyring-daemon --replace --unlock --components=secrets --daemonize, providing the password on stdin',
      ],
    ])
  })

  test('maps missing deletes without checking the collection lock', () => {
    const calls: string[][] = []
    const runner: SecurityRunner = (argv) => {
      calls.push(argv)
      return result(44)
    }
    expect(deleteLinuxKeychainItem('service', 'account', runner)).toBeUndefined()
    expect(calls).toHaveLength(1)
  })

  test('turns a classified child failure into a refusal with its remedy', () => {
    expect(() =>
      readLinuxKeychainItem('service', 'account', () =>
        secretError('ERR_SECRETS_PLATFORM_ERROR', 'libsecret not available'),
      ),
    ).toThrow('install libsecret-1-0 and gnome-keyring')
    expect(() =>
      readLinuxKeychainItem('service', 'account', () =>
        secretError(
          'ERR_SECRETS_PLATFORM_ERROR',
          'Object does not exist at path "/org/freedesktop/secrets/collection/login" (code: 19)',
        ),
      ),
    ).toThrow('gnome-keyring-daemon --replace --unlock --components=secrets --daemonize')
    expect(() =>
      readLinuxKeychainItem('service', 'account', () =>
        secretError('', 'Cannot autolaunch D-Bus without X11 $DISPLAY'),
      ),
    ).toThrow('run inside a user D-Bus session')
  })

  test('writes only on stdin and rejects a read-back mismatch', () => {
    const value = 'fixture-secret-value'
    let calls = 0
    let writeArgv: string[] | undefined
    const runner: SecurityRunner = (argv, stdin, env) => {
      calls += 1
      if (calls === 1) {
        writeArgv = argv
        expect(env?.BOTTEGA_SECRET_OPERATION).toBe('set')
        expect(new TextDecoder().decode(stdin)).toBe(value)
        return result(0)
      }
      expect(env?.BOTTEGA_SECRET_OPERATION).toBe('get')
      return result(0, 'different-value')
    }
    expect(() => writeLinuxKeychainItem('service', 'account', value, runner)).toThrow(
      'Bun.secrets set verification failed: stored value did not match',
    )
    expect(writeArgv).not.toContain(value)
  })

  test('redacts a write failure', () => {
    const value = 'fixture-secret-value'
    expect(() =>
      writeLinuxKeychainItem('service', 'account', value, () =>
        secretError('ERR_SECRETS_PLATFORM_ERROR', `rejected ${value}`),
      ),
    ).toThrow('rejected ***')
  })
})

describe('public Linux backend dispatch', () => {
  let originalPlatform: string | undefined
  let originalRunner: SecurityRunner | undefined

  beforeEach(() => {
    originalPlatform = platformHolder[PLATFORM_KEY]
    originalRunner = runnerHolder[RUNNER_KEY]
    platformHolder[PLATFORM_KEY] = 'linux'
  })

  afterEach(() => {
    if (originalPlatform === undefined) delete platformHolder[PLATFORM_KEY]
    else platformHolder[PLATFORM_KEY] = originalPlatform
    if (originalRunner === undefined) delete runnerHolder[RUNNER_KEY]
    else runnerHolder[RUNNER_KEY] = originalRunner
  })

  test('routes reads and writes through the Bun child argv', () => {
    const operations: string[] = []
    const runner: SecurityRunner = (argv, stdin, env) => {
      expect(argv).toEqual([process.execPath, '-e', expect.any(String)])
      const operation = env?.BOTTEGA_SECRET_OPERATION
      if (!operation) throw new Error('expected a Linux secret operation')
      operations.push(operation)
      if (operation === 'set') {
        expect(new TextDecoder().decode(stdin)).toBe('written-value')
        return result(0)
      }
      return result(
        0,
        operation === 'get' && operations.length === 1 ? 'read-value' : 'written-value',
      )
    }

    expect(readKeychainItem('service', 'account', runner)).toBe('read-value')
    expect(writeKeychainItem('service', 'account', 'written-value', runner)).toBeUndefined()
    expect(operations).toEqual(['get', 'set', 'get'])
  })

  test('refuses an async read without an injected runner in tests', async () => {
    await expect(readKeychainItemAsync('service', 'account')).rejects.toThrow(
      'keychain access requires an injected security runner in tests',
    )
  })

  test('refuses an async null read when the injected runner finds a locked collection', async () => {
    runnerHolder[RUNNER_KEY] = (argv) => (argv[0] === 'busctl' ? result(0, 'b true') : result(44))

    await expect(readKeychainItemAsync('service', 'account')).rejects.toThrow(
      'gnome-keyring-daemon --replace --unlock --components=secrets --daemonize',
    )
  })
})

describe('macOS security writes', () => {
  let originalPlatform: string | undefined

  beforeEach(() => {
    originalPlatform = platformHolder[PLATFORM_KEY]
    platformHolder[PLATFORM_KEY] = 'darwin'
  })

  afterEach(() => {
    if (originalPlatform === undefined) delete platformHolder[PLATFORM_KEY]
    else platformHolder[PLATFORM_KEY] = originalPlatform
  })

  test('quotes spaces, double quotes, and backslashes for the security tokenizer', () => {
    expect(quoteSecurityInputToken('a b"c\\d')).toBe('"a b\\"c\\\\d"')
  })

  test('refuses line-ending tokens without exposing them or calling security', () => {
    const value = 'unsafe\nsecret'
    let calls = 0
    let thrown: unknown
    try {
      writeKeychainItem('service', 'account', value, () => {
        calls += 1
        return result(0)
      })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toBe(
      'macOS keychain values written through security cannot contain line breaks; store the value without line breaks',
    )
    expect((thrown as Error).message).not.toContain(value)
    expect(calls).toBe(0)
  })

  test('writes through security interactive input and verifies the stored value', () => {
    const value = 'a b"c\\d'
    const calls: { argv: string[]; stdin?: Uint8Array }[] = []
    const runner: SecurityRunner = (argv, stdin) => {
      calls.push({ argv, stdin })
      return argv[1] === '-i' ? result(0) : result(0, `${value}\n`)
    }

    writeKeychainItem('account service', 'account "name"', value, runner)

    expect(calls[0]?.argv).toEqual(['security', '-i'])
    expect(new TextDecoder().decode(calls[0]?.stdin)).toBe(
      'add-generic-password -U -a "account \\"name\\"" -s "account service" -w "a b\\"c\\\\d"\n',
    )
    expect(calls[1]?.argv).toEqual([
      'security',
      'find-generic-password',
      '-a',
      'account "name"',
      '-s',
      'account service',
      '-w',
    ])
  })

  test('guards every keychain writer from secret argv and bare write prompts', () => {
    const values = ['darwin-guard-secret', 'linux-guard-secret'] as const
    let storedDarwin = ''
    let storedLinux = ''
    const runner: SecurityRunner = (argv, stdin, env) => {
      for (const value of values) {
        expect(argv.every((argument) => !argument.includes(value))).toBe(true)
      }
      if (argv[0] === 'security') {
        const command = new TextDecoder().decode(stdin)
        const storesValue =
          argv.some((argument) => /^add-(?:generic|internet)-password$/.test(argument)) ||
          /^add-(?:generic|internet)-password\b/.test(command)
        if (storesValue) {
          expect(argv.at(-1)).not.toBe('-w')
          storedDarwin = values[0]
          return result(0)
        }
        return result(0, `${storedDarwin}\n`)
      }
      if (env?.BOTTEGA_SECRET_OPERATION === 'set') {
        storedLinux = new TextDecoder().decode(stdin)
        return result(0)
      }
      return result(0, storedLinux)
    }

    writeKeychainItem('service', 'account', values[0], runner)
    writeLinuxKeychainItem('service', 'account', values[1], runner)
  })
})
