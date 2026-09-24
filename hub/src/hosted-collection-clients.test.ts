import { beforeEach, expect, test } from 'bun:test'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { db, writeTransaction } from './db.ts'
import { pullHostedNotes } from './note-cache.ts'
import { pullHostedReports } from './report-cache.ts'

beforeEach(resetFixtureStore)

const html = async () =>
  new Response('<html>app</html>', {
    status: 200,
    headers: { 'content-type': 'text/html' },
  })

test('hosted note and report pulls refuse HTML and preserve their cursors', async () => {
  writeTransaction((conn) => {
    const put = conn.query(`INSERT INTO setting(key,value) VALUES (?,?)`)
    put.run('collect.hosted-notes.cursor', 'note-before')
    put.run('collect.hosted-sends.cursor', 'report-before')
  })
  const options = { baseUrl: 'https://hub.example.test', token: 'session', fetch: html }

  await expect(pullHostedNotes(options)).rejects.toThrow(
    'hosted notes refused the response from https://hub.example.test/v1/notes',
  )
  await expect(pullHostedReports(options)).rejects.toThrow(
    'hosted reports refused the response from https://hub.example.test/v1/sends',
  )
  const rows = db()
    .query<{ key: string; value: string }, []>(
      `SELECT key,value FROM setting WHERE key IN
       ('collect.hosted-notes.cursor','collect.hosted-sends.cursor') ORDER BY key`,
    )
    .all()
  expect(rows).toEqual([
    { key: 'collect.hosted-notes.cursor', value: 'note-before' },
    { key: 'collect.hosted-sends.cursor', value: 'report-before' },
  ])
})
