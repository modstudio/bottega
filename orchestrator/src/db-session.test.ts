// Tests db.ts: session heartbeat writes.
import { expect, test } from 'bun:test'
import { db, recordSessionSeen } from './db.ts'

test('a failed heartbeat stamp never propagates', () => {
  db().exec('DROP TABLE session_seen')
  try {
    expect(() => recordSessionSeen('heartbeat-failure-test')).not.toThrow()
  } finally {
    db().exec(`CREATE TABLE session_seen (
      session_id TEXT PRIMARY KEY,
      last_seen TEXT NOT NULL
    )`)
  }
})
