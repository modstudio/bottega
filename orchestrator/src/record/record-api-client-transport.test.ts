import { expect, test } from 'bun:test'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import { recordHostedCallOutcome } from '../hosted-call-outcome.ts'
import { recordTransport } from './record-api-client-transport.ts'

test('record transport stores HTTP and transport-error outcomes for its route class', async () => {
  const database = migratedTestDatabase()
  let calls = 0
  let recorded = 0
  let finish!: () => void
  const bothRecorded = new Promise<void>((resolve) => {
    finish = resolve
  })
  const recorder = (outcome: Parameters<typeof recordHostedCallOutcome>[0]) => {
    recordHostedCallOutcome(outcome, database)
    recorded += 1
    if (recorded === 2) finish()
  }
  const transport = (async () => {
    calls += 1
    if (calls === 1) return new Response('{}', { status: 200 })
    throw new Error('fixture transport failure')
  }) as unknown as typeof fetch

  try {
    await expect(
      recordTransport('https://record.test', '/v1/docs/example', {}, transport, recorder),
    ).resolves.toMatchObject({ status: 200 })
    await expect(
      recordTransport('https://record.test', '/v1/docs/example', {}, transport, recorder),
    ).rejects.toThrow('fixture transport failure')
    await bothRecorded

    expect(
      database
        .query(
          `SELECT route_class,http_status,transport_error
           FROM hosted_call_outcome ORDER BY rowid`,
        )
        .all(),
    ).toEqual([
      { route_class: 'record-docs', http_status: 200, transport_error: null },
      { route_class: 'record-docs', http_status: null, transport_error: 'other' },
    ])
  } finally {
    database.close()
  }
})
