import { expect, test } from 'bun:test'
import { sendHostedSessionRequest } from './hosted-session-send.ts'
import { hostedCreateTask } from './task-client.ts'

const common = {
  origin: 'https://hub.example.test',
  token: 'session',
  safety: 'idempotent' as const,
}

test('hosted session writes require and send a destination while reads remain untargeted', async () => {
  const requests: Array<{ method: string; space: string | null }> = []
  const fetch = async (_input: string, init: RequestInit) => {
    requests.push({
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
  expect(requests).toEqual([
    { method: 'POST', space: 'space-project' },
    { method: 'GET', space: null },
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
    // @ts-expect-error A task-client write cannot omit its destination space.
    hostedCreateTask({}, {
      baseUrl: 'https://hub.example.test',
      token: 'session',
      fetch: async () => Response.json({}),
    })
  void compileOnlyClient
})
