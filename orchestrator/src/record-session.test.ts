import { expect, test } from 'bun:test'
import { db } from './db.ts'
import { RECORD_SESSION_KEY, RECORD_SIGN_IN_REMEDY } from './record-auth.ts'
import { currentRecordSession } from './record-session.ts'

test('record session refuses with the sign-in remedy when no bearer is stored', async () => {
  db().query('DELETE FROM schema_meta WHERE key=?').run(RECORD_SESSION_KEY)
  await expect(currentRecordSession('postgres://record.invalid/database')).rejects.toThrow(
    RECORD_SIGN_IN_REMEDY,
  )
})
