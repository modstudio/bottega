import { describe, expect, test } from 'bun:test'
import {
  classifySecretFailure,
  decideKeychainBackend,
  deleteLinuxKeychainItem,
  readLinuxKeychainItem,
  type SecurityRunner,
  writeLinuxKeychainItem,
} from './keychain.ts'
import { decideMachineKeyStore } from './machine-key-store.ts'

const bytes = (value = '') => new TextEncoder().encode(value)
const result = (exitCode: number, stdout = '', stderr = '') => ({
  exitCode,
  stdout: bytes(stdout),
  stderr: bytes(stderr),
})
const secretError = (code: string, message: string) =>
  result(70, '', JSON.stringify({ code, message }))

describe('secret backend decisions', () => {
  test('selects the platform backend and refuses unsupported platforms', () => {
    expect(decideKeychainBackend('darwin')).toBe('security')
    expect(decideKeychainBackend('linux')).toBe('bun-secrets')
    expect(() => decideKeychainBackend('win32')).toThrow(
      'keychain storage is unsupported on platform win32',
    )
  })

  test('keeps file machine keys explicit on every platform', () => {
    expect(decideMachineKeyStore(undefined, 'darwin')).toBe('keychain')
    expect(decideMachineKeyStore(undefined, 'linux')).toBe('keychain')
    expect(decideMachineKeyStore('file', 'linux')).toBe('file')
    expect(decideMachineKeyStore('file', 'win32')).toBe('file')
    expect(() => decideMachineKeyStore('unknown', 'linux')).toThrow(
      "BOTTEGA_KEYSTORE must be 'file' when set",
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

describe('Linux secret runner', () => {
  test('reads a found value through the Bun child environment', () => {
    const runner: SecurityRunner = (argv, stdin, env) => {
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
  })

  test('maps missing reads and deletes without touching a keyring', () => {
    const runner: SecurityRunner = () => result(44)
    expect(readLinuxKeychainItem('service', 'account', runner)).toBeNull()
    expect(deleteLinuxKeychainItem('service', 'account', runner)).toBeUndefined()
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
