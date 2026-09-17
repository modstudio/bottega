import { describe, expect, test } from 'bun:test'
import { PLATFORM_NAME } from './brand.ts'
import {
  clearRecordSessionToken,
  readRecordSessionToken,
  type SecurityRunner,
  writeRecordSessionToken,
} from './record-session.ts'

const bytes = (value = '') => new TextEncoder().encode(value)
const result = (exitCode: number, stdout = '', stderr = '') => ({
  exitCode,
  stdout: bytes(stdout),
  stderr: bytes(stderr),
})
const service = `${PLATFORM_NAME}-record-session`

describe('record session keychain', () => {
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
    let observed: { argv: string[]; stdin?: Uint8Array } | null = null
    writeRecordSessionToken(token, (argv, stdin) => {
      if (argv[1] === 'add-generic-password') {
        observed = { argv, stdin }
        return result(0)
      }
      return result(0, `${token}\n`)
    })
    expect(observed?.argv).toEqual([
      'security',
      'add-generic-password',
      '-U',
      '-a',
      'record',
      '-s',
      service,
      '-w',
    ])
    expect(observed?.argv).not.toContain(token)
    expect(new TextDecoder().decode(observed?.stdin)).toBe(`${token}\n${token}\n`)
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
})
