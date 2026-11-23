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
    fetch: (async (input, init) => {
      requests.push({ url: String(input), headers: new Headers(init?.headers) })
      return Response.json({ task: {}, comments: [], documents: [] })
    }) as typeof fetch,
  })

  await client.task('DEV-2613', '01990000-0000-7000-8000-000000002613')

  expect(requests).toHaveLength(1)
  expect(requests[0]?.url).toBe('https://hub.test/v1/tasks/DEV-2613')
  expect(requests[0]?.headers.get('authorization')).toBe('Bearer host-token')
  expect(requests[0]?.headers.get('x-record-space')).toBe('01990000-0000-7000-8000-000000002613')
  expect(requests[0]?.headers.get(CALLER_HEADER_NAME)).toBe(recordCallerToken())
})

test('worker workflow and task reads use their owning services', async () => {
  const urls: string[] = []
  const client = createWorkerRecordClient({
    hubBaseUrl: 'https://hub.test',
    recordApiBaseUrl: 'https://record-api.test',
    credential: async () => 'host-token',
    fetch: (async (input) => {
      const url = String(input)
      urls.push(url)
      if (url.includes('/task-flow/'))
        return Response.json({
          text: null,
          stage: { id: '01990000-0000-7000-8000-000000002617', number: 1 },
          copy: null,
        })
      return Response.json({ task: {}, comments: [], documents: [] })
    }) as typeof fetch,
  })

  await client.workflowText('text-id', '01990000-0000-7000-8000-000000002617')
  await client.task('DEV-2617', '01990000-0000-7000-8000-000000002617')

  expect(urls[0]).toStartWith('https://record-api.test/')
  expect(urls[1]).toStartWith('https://hub.test/')
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
      })) as typeof fetch,
  })

  await expect(
    client.workflowText('text-id', '01990000-0000-7000-8000-000000002617'),
  ).rejects.toThrow(
    'hosted record read of /v1/task-flow/texts/text-id on record-api.test returned a non-JSON body (status 200, content-type text/html)',
  )
})
