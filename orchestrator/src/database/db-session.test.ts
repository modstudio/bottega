// Tests db.ts: session heartbeat writes.
import { expect, test } from 'bun:test'
import { db, recordSessionSeen } from './db.ts'

test('a session stamp records its process ancestor chain', () => {
  recordSessionSeen('ancestor-test', '2026-10-21T20:00:00.000Z', [42, 7, 1])
  expect(
    db().query('SELECT ancestor_pids FROM session_seen WHERE session_id=?').get('ancestor-test'),
  ).toEqual({ ancestor_pids: '[42,7,1]' })
})

test('a session stamp without a chain preserves the stored chain', () => {
  recordSessionSeen('ancestor-preserve-test', '2026-10-21T20:00:00.000Z', [42, 7, 1])
  recordSessionSeen('ancestor-preserve-test', '2026-10-21T20:01:00.000Z')
  expect(
    db()
      .query('SELECT ancestor_pids,last_seen FROM session_seen WHERE session_id=?')
      .get('ancestor-preserve-test'),
  ).toEqual({ ancestor_pids: '[42,7,1]', last_seen: '2026-10-21T20:01:00.000Z' })
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
