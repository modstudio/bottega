import { expect, test } from 'bun:test'
import { CALLER_HEADER_NAME, recordCallerToken } from '../../../shared/record-caller.ts'
import { createWorkerRecordClient, workerRecordBaseUrl } from './worker-record-client.ts'

test.each([
  ['/v1/task-flow/texts/text-id', 'https://record-api.test'],
  ['/v1/task-flow/stages/stage-id', 'https://record-api.test'],
  ['/v1/tasks/DEV-2617', 'https://hub.test'],
])('worker record route %s uses %s', (path, expected) => {
  expect(workerRecordBaseUrl(path, 'https://hub.test', 'https://record-api.test')).toBe(expected)
})

test('a worker record route without a declared owner is refused', () => {
  expect(() =>
    workerRecordBaseUrl('/v1/unknown', 'https://hub.test', 'https://record-api.test'),
  ).toThrow('/v1/unknown')
})

test('a worker task read sends the host credential, record space, and caller', async () => {
  const requests: Array<{ url: string; headers: Headers }> = []
  const client = createWorkerRecordClient({
    hubBaseUrl: 'https://hub.test',
    recordApiBaseUrl: 'https://record-api.test',
    credential: async () => 'host-token',
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), headers: new Headers(init?.headers) })
      return Response.json({ task: {}, comments: [], documents: [] })
    }) as unknown as typeof fetch,
  })

  await client.task('DEV-2613', '01990000-0000-7000-8000-000000002613')

  expect(requests).toHaveLength(1)
  expect(requests[0]?.url).toBe('https://hub.test/v1/tasks/DEV-2613')
  expect(requests[0]?.headers.get('authorization')).toBe('Bearer host-token')
  expect(requests[0]?.headers.get('x-record-space')).toBe('01990000-0000-7000-8000-000000002613')
  expect(requests[0]?.headers.get(CALLER_HEADER_NAME)).toBe(recordCallerToken())
})

test('a worker workflow read refuses an HTML body with source diagnostics', async () => {
  const client = createWorkerRecordClient({
    hubBaseUrl: 'https://hub.test',
    recordApiBaseUrl: 'https://record-api.test',
    credential: async () => 'host-token',
    fetch: (async () =>
      new Response('<html>app</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })) as unknown as typeof fetch,
  })

  await expect(
    client.workflowText('text-id', '01990000-0000-7000-8000-000000002617'),
  ).rejects.toThrow(
    'hosted response from record-api.test/v1/task-flow/texts/text-id was not JSON (status 200, content-type text/html)',
  )
})
