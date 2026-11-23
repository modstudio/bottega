import { expect, test } from 'bun:test'
import { CALLER_HEADER_NAME, recordCallerToken } from '../../../shared/record-caller.ts'
import { createWorkerRecordClient } from './worker-record-client.ts'

test('a worker task read sends the host credential, record space, and caller', async () => {
  const requests: Array<{ url: string; headers: Headers }> = []
  const client = createWorkerRecordClient({
    baseUrl: 'https://record.test',
    credential: async () => 'host-token',
    fetch: (async (input, init) => {
      requests.push({ url: String(input), headers: new Headers(init?.headers) })
      return Response.json({ task: {}, comments: [], documents: [] })
    }) as typeof fetch,
  })

  await client.task('DEV-2613', '01990000-0000-7000-8000-000000002613')

  expect(requests).toHaveLength(1)
  expect(requests[0]?.url).toBe('https://record.test/v1/tasks/DEV-2613')
  expect(requests[0]?.headers.get('authorization')).toBe('Bearer host-token')
  expect(requests[0]?.headers.get('x-record-space')).toBe('01990000-0000-7000-8000-000000002613')
  expect(requests[0]?.headers.get(CALLER_HEADER_NAME)).toBe(recordCallerToken())
})
