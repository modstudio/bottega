// Tests db.ts: session heartbeat writes.
import { expect, test } from 'bun:test'
import { db, recordSessionSeen } from './db.ts'

test('a session stamp records its process ancestor chain', () => {
  recordSessionSeen('ancestor-test', '2026-10-21T20:00:00.000Z', [42, 7, 1])
  expect(
    db().query('SELECT ancestor_pids FROM session_seen WHERE session_id=?').get('ancestor-test'),
  ).toEqual({ ancestor_pids: '[42,7,1]' })
})

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
