import { expect, test } from 'bun:test'
import { writableDb } from '../database/db.ts'
import { hostedConfigClient } from './hosted-config-call-outcome.ts'

test('hosted config client records call outcomes', async () => {
  const database = writableDb()
  database.query('DELETE FROM hosted_call_outcome').run()
  const client = hostedConfigClient(
    { BOTTEGA_RECORD_API_URL: 'https://record.example.test' },
    async () =>
      Response.json({
        user: { id: 'user-1' },
        activeSpaceId: 'space-1',
        personalSpaceId: null,
        memberships: [],
      }),
    'token',
  )

  await client.whoami()
  await new Promise((resolve) => setTimeout(resolve, 0))

  expect(
    database
      .query('SELECT route_class,http_status FROM hosted_call_outcome ORDER BY rowid')
      .all(),
  ).toEqual([{ route_class: 'config-identity', http_status: 200 }])
})
