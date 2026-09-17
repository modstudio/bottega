import { describe, expect, test } from 'bun:test'
import {
  decodeRecordCursor,
  encodeRecordCursor,
  recordApi,
  SNAPSHOT_MAX_BYTES,
} from './record-api.ts'
import type { RecordIdentity } from './record-auth.ts'

const identity: RecordIdentity = {
  user: { id: 'user-a', email: 'a@example.test' },
  activeSpaceId: 'space-a',
  memberships: [
    { space_id: 'space-a', name: 'Space A', slug: 'space-a', role: 'owner', permission: 'write' },
  ],
}

function appWith(session: RecordIdentity | null, overrides: Record<string, unknown> = {}) {
  return recordApi({
    recordUrl: 'postgres://record.test/record',
    auth: { handler: () => Response.json({ handled: true }) },
    readSession: async () => session,
    readHealth: async () => ({ ok: true, migrations: 14 }),
    readRuns: async () => [],
    readRun: async () => null,
    readReviews: async () => [],
    readReview: async () => null,
    readProjects: async () => [],
    listDocs: async () => [],
    readDoc: async () => null,
    listDocRevisions: async () => [],
    upsertDoc: async () => ({ id, revisionId: id }),
    importDoc: async () => ({ id, revisionIds: [id] }),
    deleteDoc: async () => ({ id, revisionId: id }),
    consumeDoc: async () => ({ id, revisionId: id, alreadyConsumed: false }),
    restoreDoc: async () => ({ id, revisionId: id }),
    renameDocSubject: async () => ({ docs: 0, revisions: 0 }),
    countDocs: async () => ({ docs: 0, revisions: 0 }),
    upsertScore: async () => undefined,
    voidRun: async () => undefined,
    listScores: async () => [],
    countScores: async () => ({ scores: 0, voids: 0 }),
    upsertSnapshot: async () => ({ takenAt: '2026-09-17T12:00:00.000Z' }),
    listSnapshots: async () => [],
    ...overrides,
  })
}

const id = '01990000-0000-7000-8000-000000000001'

describe('record API', () => {
  test('refuses unauthenticated v1 requests with a sign-in remedy', async () => {
    const response = await appWith(null).request('/v1/whoami')
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({
      error: 'record authentication required',
      remedy: 'record session is missing or expired; run `orch record sign-in --email <email>`',
    })
  })

  test('refuses a session without an active space', async () => {
    const response = await appWith({ ...identity, activeSpaceId: null }).request('/v1/whoami')
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: 'record session has no active space',
      remedy: 'run `orch record space switch <slug>` to select an active space',
    })
  })

  test('returns the CLI whoami shape', async () => {
    const response = await appWith(identity).request('/v1/whoami')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(identity)
  })

  test('passes auth routes to Better Auth and reports shipped migrations', async () => {
    const app = appWith(identity)
    expect(await (await app.request('/api/auth/session')).json()).toEqual({ handled: true })
    expect(await (await app.request('/health')).json()).toEqual({ ok: true, migrations: 14 })
  })

  test('an over-limit reset request returns the same status and body as the first request', async () => {
    let requests = 0
    const app = appWith(identity, {
      auth: {
        handler: () => {
          requests++
          return requests === 1
            ? Response.json({
                status: true,
                message: 'If this email exists in our system, check your email for the reset link',
              })
            : Response.json({ message: 'Too many requests. Please try again later.' }, { status: 429 })
        },
      },
    })
    const first = await app.request('/api/auth/request-password-reset', { method: 'POST' })
    const limited = await app.request('/api/auth/request-password-reset', { method: 'POST' })
    expect(limited.status).toBe(first.status)
    expect(await limited.json()).toEqual(await first.json())
  })
})

describe('record API presentation routes', () => {
  test('validates snapshot kinds and refuses payloads over the byte cap', async () => {
    const invalid = await appWith(identity).request('/v1/snapshots/nope', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ machineId: id, payload: {} }),
    })
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toEqual({ error: 'invalid snapshot kind' })

    const oversized = await appWith(identity).request('/v1/snapshots/state', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ machineId: id, payload: 'x'.repeat(SNAPSHOT_MAX_BYTES) }),
    })
    expect(oversized.status).toBe(413)
    expect(await oversized.json()).toEqual({
      error: `snapshot payload exceeds ${SNAPSHOT_MAX_BYTES} bytes`,
    })
  })

  test('cursor encode/decode round trips and malformed cursors are rejected', async () => {
    const cursor = { at: '2026-01-02T03:04:05.000Z', id }
    expect(decodeRecordCursor(encodeRecordCursor(cursor))).toEqual(cursor)
    const response = await appWith(identity).request('/v1/runs?before=broken')
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid before cursor' })
  })

  test('validates filters and passes exact filter values', async () => {
    let received: Record<string, unknown> = {}
    const app = appWith(identity, {
      readRuns: async (input: Record<string, unknown>) => {
        received = input
        return []
      },
    })
    expect((await app.request('/v1/runs?agent=')).status).toBe(400)
    expect((await app.request('/v1/runs?limit=101')).status).toBe(400)
    expect((await app.request('/v1/runs?project=p&agent=a&job=j&status=ok')).status).toBe(200)
    expect(received).toMatchObject({ project: 'p', agent: 'a', job: 'j', status: 'ok' })
  })

  test('returns stable 400 and 404 error shapes', async () => {
    expect(await (await appWith(identity).request('/v1/runs/not-a-uuid')).json()).toEqual({
      error: 'run id must be a uuid',
    })
    const missing = await appWith(identity).request(`/v1/runs/${id}`)
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ error: 'run not found' })
  })

  test('projects contain only the presentation allowlist', async () => {
    const project = {
      name: 'one',
      keyPrefixes: ['ONE'],
      stack: null,
      landingBranch: 'main',
      color: null,
      colorDark: null,
      retiredAt: null,
    }
    const response = await appWith(identity, { readProjects: async () => [project] }).request(
      '/v1/projects',
    )
    const rows = (await response.json()) as Record<string, unknown>[]
    expect(Object.keys(rows[0]!).sort()).toEqual([
      'color',
      'colorDark',
      'keyPrefixes',
      'landingBranch',
      'name',
      'retiredAt',
      'stack',
    ])
    for (const forbidden of [
      'checkoutPath',
      'secretPaths',
      'worktree',
      'tracker',
      'mcpServer',
      'workerMcpServers',
      'mcpProbeTool',
      'envPrefix',
      'gate',
    ])
      expect(forbidden in rows[0]!).toBe(false)
  })

  test('CORS allows configured origins with credentials and omits headers otherwise', async () => {
    const app = appWith(identity, { allowedOrigins: ['https://hub.example.test'] })
    const allowed = await app.request('/v1/runs', {
      method: 'OPTIONS',
      headers: { Origin: 'https://hub.example.test', 'Access-Control-Request-Method': 'GET' },
    })
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://hub.example.test')
    expect(allowed.headers.get('access-control-allow-credentials')).toBe('true')
    const denied = await app.request('/v1/runs', {
      method: 'OPTIONS',
      headers: { Origin: 'https://other.example.test', 'Access-Control-Request-Method': 'GET' },
    })
    expect(denied.headers.get('access-control-allow-origin')).toBeNull()
  })
})

describe('record API doc write refusals', () => {
  async function put(body: Record<string, unknown>) {
    const app = appWith(identity, {
      upsertDoc: async (input: {
        scope: string
        subject: string | null
        slug: string
        body: string
        delivery: 'inject' | 'demand'
        forceInject?: string
      }) => {
        const { refuseDocWrite } = await import('../doc/doc-write-allowed.ts')
        const { RecordDocError } = await import('./record-docs.ts')
        const refusal = refuseDocWrite({
          scope: input.scope,
          subject: input.subject,
          slug: input.slug,
          body: input.body,
          delivery: input.delivery,
          forceInject: input.forceInject,
          packBytes: 0,
          globalCanonSlugs: ['.agents/rules/shared.md'],
          projectCanonSlugs: [],
          currentCanon: [],
          nextCanon: [{ slug: input.slug, body: input.body }],
        })
        if (refusal) throw new RecordDocError(refusal)
        return { id, revisionId: id }
      },
    })
    return app.request('/v1/docs', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        subject: null,
        title: 'T',
        reason: 'test',
        author: 'tester',
        ...body,
      }),
    })
  }

  test('refuses project and global inject', async () => {
    const response = await put({
      scope: 'global',
      slug: 'refused',
      body: 'B',
      delivery: 'inject',
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining('make the instruction canon'),
    })
  })

  test('refuses oversized inject', async () => {
    const response = await put({
      scope: 'job',
      subject: 'understand',
      slug: 'big',
      body: 'x'.repeat(9 * 1024),
      delivery: 'inject',
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining('threshold is 8192 bytes'),
    })
  })

  test('refuses a colliding canon path', async () => {
    const response = await put({
      scope: 'canon',
      subject: 'known',
      slug: '.agents/rules/shared.md',
      body: '---\ndescription: Shared\n---\n\nRule.\n',
      delivery: 'demand',
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining('refusing canon path collision'),
    })
  })

  test('refuses an unlinted global canon write', async () => {
    const response = await put({
      scope: 'canon',
      slug: '.agents/rules/unlinted.md',
      body: 'Rule without required metadata.\n',
      delivery: 'demand',
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining('refusing canon write'),
    })
  })
})
