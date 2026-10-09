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

test('hosted send pull updates the existing row with the same record id', async () => {
  writeTransaction((conn) => {
    conn
      .query(`INSERT INTO send(record_id,at,window,recipients,projects,items,status,error,test)
        VALUES ('01990000-0000-7000-8000-000000000301','2026-10-08T12:00:00.000Z','day','[]','[]',1,'sent',NULL,0)`)
      .run()
  })
  const fetch = async () =>
    Response.json({
      sends: [
        {
          id: '01990000-0000-7000-8000-000000000301',
          at: '2026-10-08T13:00:00.000Z',
          window: 'day',
          recipients: '[]',
          projects: '[]',
          items: 1,
          status: 'failed',
          error: null,
          test: 0,
          created_at: '2026-10-08T12:00:00.000Z',
          machine: 'other',
        },
      ],
      cursor: '2026-10-08T12:00:00.000Z',
    })

  await pullHostedReports({ baseUrl: 'https://hub.example.test', token: 'session', fetch })

  expect(db().query<{ count: number }, []>('SELECT count(*) count FROM send').get()?.count).toBe(1)
  expect(
    db().query<{ at: string; status: string }, []>('SELECT at,status FROM send').get(),
  ).toEqual({ at: '2026-10-08T13:00:00.000Z', status: 'failed' })
})
