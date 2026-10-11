import { describe, expect, test } from 'bun:test'
import {
  type LiveReadingCapture,
  RELEASE_LIVE_READING_TIMEOUT_MS,
  readLiveCommit,
} from './live-reading.ts'

const fullCommit = 'ABCDEF0123456789ABCDEF0123456789ABCDEF01'

function read(capture: LiveReadingCapture) {
  return readLiveCommit('read-live', '/project', (command, cwd, timeoutMs) => {
    expect({ command, cwd, timeoutMs }).toEqual({
      command: 'read-live',
      cwd: '/project',
      timeoutMs: RELEASE_LIVE_READING_TIMEOUT_MS,
    })
    return capture
  })
}

describe('release live reading', () => {
  test('accepts exactly one full commit and lowercases it', () => {
    expect(read({ exitCode: 0, output: ` ${fullCommit}\n`, timedOut: false })).toEqual({
      ok: true,
      commit: fullCommit.toLowerCase(),
    })
  })

  test.each(['', `${fullCommit}\nextra`, 'abcdef0'])(
    'rejects output that is not one full commit: %j',
    (output) => {
      expect(read({ exitCode: 0, output, timedOut: false })).toMatchObject({
        ok: false,
        kind: 'invalid-output',
      })
    },
  )

  test('distinguishes a nonzero exit', () => {
    expect(read({ exitCode: 7, output: 'unavailable', timedOut: false })).toEqual({
      ok: false,
      kind: 'nonzero-exit',
      failure: 'live command failed (exit 7): unavailable',
    })
  })

  test('distinguishes a timeout from other failures', () => {
    expect(read({ exitCode: 1, output: 'partial', timedOut: true })).toEqual({
      ok: false,
      kind: 'timeout',
      failure: 'live reading timed out',
    })
  })

  test('withholds secret-shaped failure output', () => {
    const secret = 'password=fixture-not-a-real-secret'
    const reading = read({ exitCode: 2, output: secret, timedOut: false })
    expect(reading).toMatchObject({ ok: false, kind: 'nonzero-exit' })
    expect(reading).not.toEqual(
      expect.objectContaining({ failure: expect.stringContaining(secret) }),
    )
  })
})
