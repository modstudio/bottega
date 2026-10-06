import { describe, expect, test } from 'bun:test'
import { createRecordClient, type RecordFetch } from './record-client.ts'

const whoamiBody = {
  user: { id: 'user-a', email: 'a@example.test' },
  activeSpaceId: 'space-a',
  personalSpaceId: 'space-a',
  memberships: [],
}

const boardRootId = '01990000-0000-7000-8000-000000000011'
const boardReplyId = '01990000-0000-7000-8000-000000000012'
const boardMessage = {
  id: boardRootId,
  kind: 'notice',
  threadRootId: null,
  title: 'Hosted notice',
  body: 'Body',
  audience: 'architects',
  origin: { kind: 'operator', session: null, harness: null, project: null, runId: null },
  senderTags: [],
  createdAt: '2026-10-06T12:00:00.000Z',
  expiresAt: '2026-10-07T12:00:00.000Z',
  withdrawnAt: null,
  state: 'open',
  acceptedReplyId: null,
  acceptedBy: null,
  acceptedAt: null,
  noteId: null,
  notePendingError: null,
  revision: '1',
  scopeProjectIds: [],
  recipientUserIds: [],
  claimId: null,
  authorUserId: 'user-a',
  authorSession: null,
  ackRequired: false,
  ackDeadline: null,
}

const boardOverview = {
  id: boardRootId,
  kind: 'notice',
  title: 'Hosted notice',
  audience: 'architects',
  origin: boardMessage.origin,
  senderTags: [],
  createdAt: boardMessage.createdAt,
  expiresAt: boardMessage.expiresAt,
  withdrawnAt: null,
  ackRequired: false,
  ackDeadline: null,
  state: 'open',
  reached: null,
  acknowledged: null,
  unacknowledged: null,
  store: 'hosted',
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

  test('calls every board route with its query or body and forwarded authentication', async () => {
    const requests: Array<{
      url: string
      method: string
      body: unknown
      cookie: string | null
      authorization: string | null
    }> = []
    const fetch: RecordFetch = async (url, init) => {
      const headers = new Headers(init?.headers)
      requests.push({
        url,
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : null,
        cookie: headers.get('Cookie'),
        authorization: headers.get('Authorization'),
      })
      if (url.includes('/status')) return jsonResponse({ message: boardMessage, receipts: [] })
      if (url.includes('/threads/')) return jsonResponse({ root: boardMessage, replies: [] })
      if (url.endsWith('/accept')) return jsonResponse({ root: boardMessage, replies: [] })
      if (url.includes('/replies'))
        return jsonResponse({ ...boardMessage, id: boardReplyId, threadRootId: boardRootId })
      if (url.endsWith('/withdraw'))
        return jsonResponse({ ...boardMessage, withdrawnAt: '2026-10-06T13:00:00.000Z' })
      if (init?.method === 'PUT') return jsonResponse(boardMessage)
      return jsonResponse({ messages: [boardOverview], truncated: false })
    }
    const client = clientWith(fetch, { cookie: 'sid=abc', authorization: 'Bearer tok' })
    await client.boardList({ kind: 'notice', open: true, includeEnded: true })
    await client.boardThread(boardRootId)
    await client.boardStatus(boardRootId)
    await client.boardPost({
      id: boardRootId,
      kind: 'notice',
      audience: 'architects',
      title: 'Hosted notice',
      body: 'Body',
      expiresAt: '2026-10-07T12:00:00.000Z',
      project: 'bottega',
    })
    await client.boardReply(boardRootId, { id: boardReplyId, body: 'Reply' })
    await client.boardAccept(boardRootId, boardReplyId)
    await client.boardWithdraw(boardRootId)

    expect(requests.map(({ url, method, body }) => ({ url, method, body }))).toEqual([
      {
        url: 'https://api.example.test/v1/board/messages?kind=notice&open=true&includeEnded=true',
        method: 'GET',
        body: null,
      },
      {
        url: `https://api.example.test/v1/board/threads/${boardRootId}`,
        method: 'GET',
        body: null,
      },
      {
        url: `https://api.example.test/v1/board/messages/${boardRootId}/status`,
        method: 'GET',
        body: null,
      },
      {
        url: 'https://api.example.test/v1/board/messages',
        method: 'PUT',
        body: {
          id: boardRootId,
          kind: 'notice',
          audience: 'architects',
          title: 'Hosted notice',
          body: 'Body',
          expiresAt: '2026-10-07T12:00:00.000Z',
          project: 'bottega',
        },
      },
      {
        url: `https://api.example.test/v1/board/messages/${boardRootId}/replies`,
        method: 'POST',
        body: { id: boardReplyId, body: 'Reply' },
      },
      {
        url: `https://api.example.test/v1/board/messages/${boardRootId}/accept`,
        method: 'POST',
        body: { replyId: boardReplyId },
      },
      {
        url: `https://api.example.test/v1/board/messages/${boardRootId}/withdraw`,
        method: 'POST',
        body: {},
      },
    ])
    expect(
      requests.every(
        ({ cookie, authorization }) => cookie === 'sid=abc' && authorization === 'Bearer tok',
      ),
    ).toBe(true)
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

  test('opts doc lists into readable spaces only when requested', async () => {
    const urls: string[] = []
    const fetch: RecordFetch = async (input) => {
      urls.push(input)
      return jsonResponse({ items: [], nextCursor: null })
    }
    const client = clientWith(fetch)
    await client.docs()
    await client.docs({ acrossReadableSpaces: true })
    expect(urls).toEqual([
      'https://api.example.test/v1/docs',
      'https://api.example.test/v1/docs?acrossReadableSpaces=true',
    ])
  })

  test('scores and voids hosted runs without sending a scorer identity', async () => {
    const runId = '01990000-0000-7000-8000-000000000001'
    const requests: { url: string; method: string; body: Record<string, unknown> }[] = []
    const fetch: RecordFetch = async (url, init) => {
      requests.push({
        url,
        method: init?.method ?? '',
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      })
      return jsonResponse({ ok: true })
    }
    const client = clientWith(fetch)
    await client.score(runId, {
      delivery: 'full',
      quality: 'right',
      fidelity: 'faithful',
      note: null,
      scoredAt: '2026-09-22T12:00:00.000Z',
    })
    await client.void(runId, { reason: 'not evidence' })
    expect(requests).toEqual([
      {
        url: `https://api.example.test/v1/runs/${runId}/score`,
        method: 'PUT',
        body: {
          delivery: 'full',
          quality: 'right',
          fidelity: 'faithful',
          note: null,
          scoredAt: '2026-09-22T12:00:00.000Z',
        },
      },
      {
        url: `https://api.example.test/v1/runs/${runId}/void`,
        method: 'POST',
        body: { reason: 'not evidence' },
      },
    ])
  })

  test('writes docs, config entries, and settings permissions through their record routes', async () => {
    const id = '01990000-0000-7000-8000-000000000001'
    const revisionId = '01990000-0000-7000-8000-000000000002'
    const requests: Array<{ url: string; method: string; body: unknown }> = []
    const fetch: RecordFetch = async (url, init) => {
      requests.push({ url, method: init?.method ?? '', body: JSON.parse(String(init?.body)) })
      if (url.endsWith('/v1/settings/permission')) {
        return jsonResponse({
          revision: revisionId,
          permissions: { allow: [], ask: [], deny: [] },
        })
      }
      if (url.includes('/v1/config/entries/')) {
        if (init?.method === 'DELETE') return jsonResponse({ deleted: true })
        return jsonResponse({
          key: 'autonomy.preset',
          environment: 'default',
          scope: 'user',
          value: 'manual',
          rowVersion: 2,
          updatedAt: '2026-09-28T12:00:00.000Z',
        })
      }
      return jsonResponse({ id, revisionId })
    }
    const client = clientWith(fetch)
    await client.putDoc({
      scope: 'canon',
      subject: null,
      owner: id,
      slug: 'preferences',
      title: 'Preferences',
      body: 'Body',
      delivery: 'inject',
      reason: 'updated',
      author: 'hub-dashboard',
      expectedRevision: revisionId,
    })
    await client.deleteDoc(id, {
      reason: 'obsolete',
      author: 'hub-dashboard',
      expectedRevision: revisionId,
    })
    await client.putConfigEntry('autonomy.preset', {
      scope: 'user',
      value: 'manual',
      expectedRowVersion: 1,
    })
    await client.deleteConfigEntry('autonomy.stage.review', {
      scope: 'user',
      expectedRowVersion: 3,
    })
    await client.settingsPermission({
      target: { kind: 'user' },
      list: 'allow',
      rule: 'Bash(orch *)',
      operation: 'add',
      reason: 'needed',
      expectedRevision: revisionId,
    })

    expect(requests.map(({ url, method }) => [url, method])).toEqual([
      ['https://api.example.test/v1/docs', 'PUT'],
      [`https://api.example.test/v1/docs/${id}`, 'DELETE'],
      ['https://api.example.test/v1/config/entries/autonomy.preset', 'PUT'],
      ['https://api.example.test/v1/config/entries/autonomy.stage.review', 'DELETE'],
      ['https://api.example.test/v1/settings/permission', 'POST'],
    ])
    expect(requests[2]?.body).toEqual({
      scope: 'user',
      value: 'manual',
      expectedRowVersion: 1,
      environment: 'default',
    })
  })

  test('maps 401 to UNAUTHORIZED with the API remedy text', async () => {
    const fetch: RecordFetch = async () =>
      jsonResponse({ error: 'record authentication required', remedy: 'sign in again' }, 401)
    await expect(clientWith(fetch).whoami()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'sign in again',
    })
  })

  test('maps 409 to CONFLICT and 404 to NOT_FOUND', async () => {
    const conflict: RecordFetch = async () =>
      jsonResponse({ error: 'record session has no active space' }, 409)
    const missing: RecordFetch = async () => jsonResponse({ error: 'run not found' }, 404)
    await expect(clientWith(conflict).whoami()).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'record session has no active space',
    })
    await expect(
      clientWith(missing).run('01990000-0000-7000-8000-000000000001'),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'run not found',
    })
  })

  test('maps permission and rate refusals without hiding their messages', async () => {
    const forbidden: RecordFetch = async () => jsonResponse({ error: 'not the author' }, 403)
    const limited: RecordFetch = async () => jsonResponse({ error: 'post rate cap reached' }, 429)
    await expect(clientWith(forbidden).boardWithdraw(boardRootId)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'not the author',
    })
    await expect(
      clientWith(limited).boardPost({
        id: boardRootId,
        kind: 'notice',
        audience: 'architects',
        title: 'Title',
        body: 'Body',
        expiresAt: '2026-10-07T12:00:00.000Z',
      }),
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS', message: 'post rate cap reached' })
  })

  test('explains a bare board-route 404 as an undeployed board', async () => {
    const fetch: RecordFetch = async () => new Response(null, { status: 404 })
    await expect(clientWith(fetch).boardList({})).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'the hosted record does not serve the message board yet',
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

  test('agent snapshots retain who operates the endpoint', async () => {
    const fetch: RecordFetch = async () =>
      jsonResponse({
        items: [
          {
            id: '01990000-0000-7000-8000-000000000001',
            machineId: '01990000-0000-7000-8000-000000000002',
            takenAt: '2026-09-17T12:00:00.000Z',
            kind: 'agents',
            payload: [
              {
                name: 'local-acp',
                caps: { readsRepo: true },
                model: 'operator/model',
                operatedBy: 'self',
                contextTokens: 131_072,
                maxPromptBytes: null,
                timeoutMs: 60_000,
              },
            ],
          },
        ],
      })
    const result = await clientWith(fetch).snapshots()
    const snapshot = result.items[0]
    expect(snapshot?.kind).toBe('agents')
    if (snapshot?.kind !== 'agents') return
    expect(snapshot.payload[0]?.operatedBy).toBe('self')
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
