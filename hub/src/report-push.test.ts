import { beforeEach, expect, test } from 'bun:test'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { writeTransaction } from './db.ts'
import { countMirrorWrites } from './hosted-reports.ts'
import { pushReports } from './report-push.ts'

beforeEach(resetFixtureStore)

const at = '2026-10-08T12:00:00.000Z'

function insertSend(recordId: string | null) {
  writeTransaction((conn) => {
    conn
      .query(`INSERT INTO send(record_id,at,window,recipients,projects,items,status,error,test)
        VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(recordId, at, 'day', '[]', '[]', 1, 'sent', null, 0)
  })
}

test('report push refuses a send without a record id before any request', async () => {
  insertSend(null)
  let requests = 0
  const fetch = async () => {
    requests++
    return Response.json({})
  }
  await expect(
    pushReports({
      baseUrl: 'https://hub.example.test',
      token: 'test',
      fetch,
    }),
  ).rejects.toThrow('send local row 1 has no record id')
  expect(requests).toBe(0)
})

test('report push sends the existing record id without a legacy local id', async () => {
  const recordId = '01990000-0000-7000-8000-000000000201'
  insertSend(recordId)
  let sent: Record<string, unknown> | undefined
  const fetch = async (input: string, init?: RequestInit) => {
    const path = new URL(input).pathname
    if (path === '/v1/sends/mirror') {
      sent = (JSON.parse(String(init?.body)) as { sends: Record<string, unknown>[] }).sends[0]
      return Response.json({ upserted: 1 })
    }
    if (path === '/v1/sends/counts') return Response.json({ sends: 1 })
    return Response.json({ error: 'unexpected request' }, { status: 500 })
  }

  await pushReports({ baseUrl: 'https://hub.example.test', token: 'test', fetch })

  expect(sent?.id).toBe(recordId)
  expect(sent).not.toHaveProperty('legacy_local_id')
})

test('send mirror counts only rows written when an id conflicts', () => {
  expect(countMirrorWrites([[{ id: 'written' }], []])).toBe(1)
})
