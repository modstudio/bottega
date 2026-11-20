import { expect, mock, spyOn, test } from 'bun:test'
import * as recordCallTrace from '../../shared/record-call-trace.ts'
import { CALLER_HEADER_NAME, withRecordCaller } from '../../shared/record-caller.ts'
import { sendHostedSessionRequest } from './hosted-session-send.ts'
import { hostedCreateTask } from './task-client.ts'

const common = {
  origin: 'https://hub.example.test',
  token: 'session',
  safety: 'idempotent' as const,
}

test('hosted session writes require and send a destination while reads remain untargeted', async () => {
  const requests: Array<{ caller: string | null; method: string; space: string | null }> = []
  const fetch = async (_input: string, init: RequestInit) => {
    requests.push({
      caller: new Headers(init.headers).get(CALLER_HEADER_NAME),
      method: init.method ?? 'GET',
      space: new Headers(init.headers).get('x-record-space'),
    })
    return Response.json({})
  }
  const writeUrl = 'https://hub.example.test/v1/notes'

  await expect(
    sendHostedSessionRequest({
      ...common,
      url: writeUrl,
      method: 'POST',
      recordSpace: '',
      fetch,
    }),
  ).rejects.toThrow('hosted write names no destination space: /v1/notes')
  expect(requests).toEqual([])

  await withRecordCaller('cli:task/create', async () => {
    await sendHostedSessionRequest({
      ...common,
      url: writeUrl,
      method: 'POST',
      recordSpace: 'space-project',
      fetch,
    })
    await sendHostedSessionRequest({
      ...common,
      url: 'https://hub.example.test/v1/notes/counts',
      method: 'GET',
      fetch,
    })
  })
  expect(requests).toEqual([
    { caller: 'cli:task/create', method: 'POST', space: 'space-project' },
    { caller: 'cli:task/create', method: 'GET', space: null },
  ])

  const compileOnly = () =>
    // @ts-expect-error A hosted write cannot omit its destination space.
    sendHostedSessionRequest({
      ...common,
      url: 'https://hub.example.test/v1/notes',
      method: 'POST',
      fetch: async () => Response.json({}),
    })
  void compileOnly

  const compileOnlyClient = () =>
    hostedCreateTask(
      {},
      // @ts-expect-error A task-client write cannot omit its destination space.
      {
        baseUrl: 'https://hub.example.test',
        token: 'session',
        fetch: async () => Response.json({}),
      },
    )
  void compileOnlyClient
})

test('hosted session sends pass through the record trace seam', async () => {
  const trace = spyOn(recordCallTrace, 'tracedRecordFetch')
  try {
    const response = await sendHostedSessionRequest({
      ...common,
      url: 'https://hub.example.test/v1/tasks',
      method: 'GET',
      fetch: async () =>
        new Response('[]', {
          headers: { 'content-length': '2', 'content-type': 'application/json' },
        }),
    })

    expect(await response.json()).toEqual([])
    expect(trace).toHaveBeenCalledTimes(1)
    expect(trace.mock.calls[0]?.[0]).toBe('https://hub.example.test/v1/tasks')
  } finally {
    mock.restore()
  }
})
