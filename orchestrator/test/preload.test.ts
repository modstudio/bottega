import { expect, test } from 'bun:test'
import { readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { DB_PATH, db } from '../src/db.ts'

test('the preload creates a store and never clears one', () => {
  const preload = readFileSync(new URL('./preload.ts', import.meta.url), 'utf8')
  expect(preload).not.toMatch(/DELETE FROM/)
  expect(preload).not.toMatch(/TRUNCATE/)
})

test('the suite runs against a store the preload minted under the temporary directory', () => {
  expect(DB_PATH).toBe(process.env.ORCH_DB)
  expect(realpathSync(DB_PATH).startsWith(realpathSync(tmpdir()))).toBe(true)
  db()
    .query('INSERT INTO session_seen (session_id, last_seen) VALUES (?, ?)')
    .run('preload-test', '2026-09-07T00:00:00.000Z')
})

test('a row written by one test is absent from the next because the store is fresh, not cleared', () => {
  const { n } = db().query('SELECT COUNT(*) AS n FROM session_seen').get() as { n: number }
  expect(n).toBe(0)
})
