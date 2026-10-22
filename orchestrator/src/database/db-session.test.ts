// Tests db.ts: session heartbeat writes.
import { expect, test } from 'bun:test'
import { db, recordSessionSeen } from './db.ts'

test('a session stamp records its process ancestor chain', () => {
  const at = '2026-10-21T20:00:00.000Z'
  const chain = [{ pid: 42, startTime: 'birth-42' }]
  recordSessionSeen('ancestor-test', at, { chain, confirmedAt: at })
  expect(
    db()
      .query('SELECT ancestor_chain,ancestor_confirmed_at FROM session_seen WHERE session_id=?')
      .get('ancestor-test'),
  ).toEqual({ ancestor_chain: JSON.stringify(chain), ancestor_confirmed_at: at })
})

test('a session stamp without a chain preserves the stored chain', () => {
  const chain = [{ pid: 42, startTime: 'birth-42' }]
  recordSessionSeen('ancestor-preserve-test', '2026-10-21T20:00:00.000Z', {
    chain,
    confirmedAt: '2026-10-21T20:00:00.000Z',
  })
  recordSessionSeen('ancestor-preserve-test', '2026-10-21T20:01:00.000Z')
  expect(
    db()
      .query(
        `SELECT ancestor_chain,ancestor_confirmed_at,last_seen
         FROM session_seen WHERE session_id=?`,
      )
      .get('ancestor-preserve-test'),
  ).toEqual({
    ancestor_chain: JSON.stringify(chain),
    ancestor_confirmed_at: '2026-10-21T20:00:00.000Z',
    last_seen: '2026-10-21T20:01:00.000Z',
  })
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
