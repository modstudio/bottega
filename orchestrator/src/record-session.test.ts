import { describe, expect, test } from 'bun:test'
import { db } from './db.ts'
import { RECORD_SESSION_KEY, RECORD_SIGN_IN_REMEDY } from './record-auth.ts'
import { currentRecordSession, storedRecordToken } from './record-session.ts'

const missingKeychain = () => ({
  exitCode: 44,
  stdout: new Uint8Array(),
  stderr: new Uint8Array(),
})

test('record session refuses with the sign-in remedy when no bearer is stored', async () => {
  db().query('DELETE FROM schema_meta WHERE key=?').run(RECORD_SESSION_KEY)
  await expect(
    currentRecordSession('postgres://record.invalid/database', db(), missingKeychain),
  ).rejects.toThrow(RECORD_SIGN_IN_REMEDY)
})

describe('legacy record session migration', () => {
  test('moves the legacy token to the keychain and deletes the database secret', () => {
    const token = 'legacy-fixture-token'
    db().query('INSERT INTO schema_meta (key,value) VALUES (?,?)').run(RECORD_SESSION_KEY, token)
    const writes: string[] = []
    const runner = (argv: string[], stdin?: Uint8Array) => {
      if (argv[1] === 'find-generic-password') return missingKeychain()
      writes.push(new TextDecoder().decode(stdin).trim())
      return { exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array() }
    }
    expect(storedRecordToken(db(), runner, true)).toBe(token)
    expect(writes).toEqual([token])
    expect(
      db().query('SELECT value FROM schema_meta WHERE key=?').get(RECORD_SESSION_KEY),
    ).toBeNull()
  })

  test('a linked-worktree read neither uses nor deletes the legacy database secret', () => {
    db()
      .query('INSERT INTO schema_meta (key,value) VALUES (?,?)')
      .run(RECORD_SESSION_KEY, 'legacy-fixture-token')
    expect(storedRecordToken(db(), missingKeychain, false)).toBeNull()
    expect(
      db()
        .query<{ value: string }, [string]>('SELECT value FROM schema_meta WHERE key=?')
        .get(RECORD_SESSION_KEY)?.value,
    ).toBe('legacy-fixture-token')
  })

  test('an existing keychain token wins without changing the legacy database secret', () => {
    db()
      .query('INSERT INTO schema_meta (key,value) VALUES (?,?)')
      .run(RECORD_SESSION_KEY, 'legacy-fixture-token')
    const keychain = () => ({
      exitCode: 0,
      stdout: new TextEncoder().encode('keychain-fixture-token\n'),
      stderr: new Uint8Array(),
    })
    expect(storedRecordToken(db(), keychain, true)).toBe('keychain-fixture-token')
    expect(
      db()
        .query<{ value: string }, [string]>('SELECT value FROM schema_meta WHERE key=?')
        .get(RECORD_SESSION_KEY)?.value,
    ).toBe('legacy-fixture-token')
  })
})
