import { describe, expect, test } from 'bun:test'
import { createRecordClient, type RecordFetch } from './record-client.ts'

const whoamiBody = {
  user: { id: 'user-a', email: 'a@example.test' },
  activeSpaceId: 'space-a',
  personalSpaceId: 'space-a',
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

  test('sets the active space through the authenticated record API', async () => {
    const captured = { method: '', body: '' }
    const fetch: RecordFetch = async (_input, init) => {
      captured.method = init?.method ?? ''
      captured.body = String(init?.body)
      return jsonResponse({ activeSpaceId: 'space-b' })
    }
    await clientWith(fetch).setActiveSpace('space-b')
    expect(captured).toEqual({ method: 'PUT', body: JSON.stringify({ spaceId: 'space-b' }) })
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

  test('rejects malformed snapshot and document bodies', async () => {
    const fetch: RecordFetch = async () => jsonResponse({ items: [{ nope: true }] })
    const client = clientWith(fetch)
    for (const request of [
      () => client.docs(),
      () => client.doc('01990000-0000-7000-8000-000000000001'),
      () => client.docRevisions('01990000-0000-7000-8000-000000000001'),
    ]) {
      await expect(request()).rejects.toMatchObject({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'record API returned an invalid body',
      })
    }
  })

  test('keeps valid snapshots and reports each malformed item', async () => {
    const base = {
      id: '01990000-0000-7000-8000-000000000001',
      machineId: '01990000-0000-7000-8000-000000000002',
      takenAt: '2026-09-17T12:00:00.000Z',
    }
    const fetch: RecordFetch = async () =>
      jsonResponse({
        items: [
          {
            ...base,
            kind: 'state',
            payload: {
              live: [],
              stale: 0,
              matrix: [],
              guide: [],
              health: [],
              totals: { runs: 0, failed: 0, stale_n: 0, toks: 0, scored: 0 },
              unscored: 0,
              spawns: [],
              agents: [],
              byRepo: [],
            },
          },
          { ...base, kind: 'blockers', payload: { blockers: [] } },
          {
            ...base,
            kind: 'health',
            payload: {
              header: 'Harness health only',
              days: 14,
              from: '2026-09-03T12:00:00.000Z',
              classes: [],
              falseVerdicts: [],
              landingRefusals: 0,
              mcpProbeFailures: 0,
              mcpUnprobed: 0,
              contention: { resources: [], sessions: [] },
            },
          },
          { ...base, kind: 'jobs', payload: [] },
          {
            ...base,
            kind: 'agents',
            payload: [
              {
                name: 'agy',
                caps: { readsRepo: false, contextTokens: null },
                model: 'gemini-3.1-pro-high',
                operatedBy: 'vendor',
                contextTokens: null,
                maxPromptBytes: null,
                timeoutMs: 60_000,
              },
            ],
          },
        ],
      })

    const result = await clientWith(fetch).snapshots()
    expect(result.items.map((item) => item.kind)).toEqual(['state', 'blockers', 'health', 'jobs'])
    expect(result.ignored).toHaveLength(1)
    expect(result.ignored[0]).toContain('agents snapshot ignored:')
    expect(result.ignored[0]).toContain('caps.contextTokens')
    expect(result.ignored[0]).toContain('expected boolean, received null')
  })
})
