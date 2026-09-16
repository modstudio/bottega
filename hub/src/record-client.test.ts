import { describe, expect, test } from 'bun:test'
import { createRecordClient, type RecordFetch } from './record-client.ts'

const whoamiBody = {
  user: { id: 'user-a', email: 'a@example.test' },
  activeSpaceId: 'space-a',
  memberships: [],
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function clientWith(fetch: RecordFetch, headers: { cookie?: string; authorization?: string } = {}) {
  return createRecordClient({
    baseUrl: 'https://api.example.test',
    headers,
    fetch,
  })
}

describe('record client', () => {
  test('forwards Cookie and Authorization unchanged', async () => {
    const captured = { url: '', cookie: '', authorization: '' }
    const fetch: RecordFetch = async (input, init) => {
      captured.url = input
      const headers = new Headers(init?.headers)
      captured.cookie = headers.get('Cookie') ?? ''
      captured.authorization = headers.get('Authorization') ?? ''
      return jsonResponse(whoamiBody)
    }
    await clientWith(fetch, { cookie: 'sid=abc', authorization: 'Bearer tok' }).whoami()
    expect(captured.url).toBe('https://api.example.test/v1/whoami')
    expect(captured.cookie).toBe('sid=abc')
    expect(captured.authorization).toBe('Bearer tok')
  })

  test('maps 401 to UNAUTHORIZED with the API remedy text', async () => {
    const fetch: RecordFetch = async () =>
      jsonResponse({ error: 'record authentication required', remedy: 'sign in again' }, 401)
    await expect(clientWith(fetch).whoami()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'sign in again',
    })
  })

  test('maps 409 to PRECONDITION_FAILED and 404 to NOT_FOUND', async () => {
    const conflict: RecordFetch = async () =>
      jsonResponse({ error: 'record session has no active space' }, 409)
    const missing: RecordFetch = async () => jsonResponse({ error: 'run not found' }, 404)
    await expect(clientWith(conflict).whoami()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'record session has no active space',
    })
    await expect(
      clientWith(missing).run('01990000-0000-7000-8000-000000000001'),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'run not found',
    })
  })

  test('rejects a malformed body', async () => {
    const fetch: RecordFetch = async () => jsonResponse({ nope: true })
    await expect(clientWith(fetch).whoami()).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'record API returned an invalid body',
    })
  })
})
