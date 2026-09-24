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
  personalSpaceId: 'space-a',
  memberships: [
    { space_id: 'space-a', name: 'Space A', slug: 'space-a', role: 'owner', permission: 'write' },
  ],
}

function appWith(session: RecordIdentity | null, overrides: Record<string, unknown> = {}) {
  return recordApi({
    recordUrl: 'postgres://record.test/record',
    auth: { handler: () => Response.json({ handled: true }) },
    readSession: async () => session,
    setActiveSpace: async () => undefined,
    readHealth: async () => ({ ok: true, migrations: 14 }),
    readRuns: async () => [],
    readRunsWindow: async (input: { offset: number; limit: 25 | 50 | 100 }) => ({
      items: [],
      matched: 0,
      offset: input.offset,
      limit: input.limit,
      facets: { agents: [], projects: [] },
      totals: { runs: 0, scored: 0, voided: 0, failed: 0 },
      vendors: [],
      unscored: 0,
      live: [],
    }),
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
    unvoidRun: async () => undefined,
    listScores: async () => [],
    countScores: async () => ({ scores: 0, voids: 0 }),
    upsertSnapshot: async () => ({ takenAt: '2026-09-17T12:00:00.000Z' }),
    listSnapshots: async () => [],
    listConfigEntries: async () => [],
    getConfigEntry: async () => null,
    putConfigEntry: async () => {
      throw new Error('not implemented')
    },
    deleteConfigEntry: async () => undefined,
    listConfigSecrets: async () => [],
    getConfigSecret: async () => null,
    putConfigSecret: async () => {
      throw new Error('not implemented')
    },
    deleteConfigSecret: async () => undefined,
    currentDataKey: async () => null,
    listDataKeys: async () => [],
    getDataKey: async () => null,
    createDataKey: async () => ({ id, version: 1 }),
    addDataKeyWraps: async () => undefined,
    retireDataKey: async () => undefined,
    deleteDataKeyWraps: async () => undefined,
    listMachineKeys: async () => [],
    registerMachineKey: async () => {
      throw new Error('not implemented')
    },
    revokeMachineKey: async () => undefined,
    ...overrides,
  })
}

const id = '01990000-0000-7000-8000-000000000001'

describe('record API', () => {
  test('requires an unvoid note and passes the authenticated tenant to the service', async () => {
    const calls: Array<{ id: string; note: string; userId: string; spaceId: string }> = []
    const app = appWith(identity, {
      unvoidRun: async (input: { id: string; note: string; userId: string; spaceId: string }) => {
        calls.push(input)
      },
    })
    const missing = await app.request(`/v1/runs/${id}/unvoid`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(missing.status).toBe(400)
    expect(await missing.json()).toEqual({ error: 'invalid unvoid: note is required' })
    const response = await app.request(`/v1/runs/${id}/unvoid`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ note: 'mistaken void' }),
    })
    expect(response.status).toBe(200)
    expect(calls).toEqual([
      expect.objectContaining({ id, note: 'mistaken void', userId: 'user-a', spaceId: 'space-a' }),
    ])
  })

  test('records the authenticated user id and ignores a caller scorer label', async () => {
    const scorers: string[] = []
    const app = appWith(identity, {
      upsertScore: async (input: { scoredBy: string }) => {
        scorers.push(input.scoredBy)
      },
    })
    const score = async (scoredBy?: string) =>
      app.request(`/v1/runs/${id}/score`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          delivery: 'none',
          quality: null,
          fidelity: null,
          note: null,
          scoredAt: '2026-09-22T12:00:00.000Z',
          ...(scoredBy ? { scoredBy } : {}),
        }),
      })
    expect((await score()).status).toBe(200)
    expect((await score('caller-controlled')).status).toBe(200)
    expect(scorers).toEqual(['user-a', 'user-a'])
  })

  test('refuses unauthenticated v1 requests with a sign-in remedy', async () => {
    const response = await appWith(null).request('/v1/whoami')
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({
      error: 'record authentication required',
      remedy: 'record session is missing or expired; run `orch record sign-in --email <email>`',
    })
  })

  test('reports a session without an active space while scoped routes refuse it', async () => {
    const response = await appWith({ ...identity, activeSpaceId: null }).request('/v1/whoami')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ...identity, activeSpaceId: null })

    const scoped = await appWith({ ...identity, activeSpaceId: null }).request('/v1/projects')
    expect(scoped.status).toBe(409)
    expect(await scoped.json()).toEqual({
      error: 'record session has no active space',
      remedy: 'run `orch record space switch <slug>` to select an active space',
    })
  })

  test('returns the CLI whoami shape', async () => {
    const response = await appWith(identity).request('/v1/whoami')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(identity)
  })

  test('personal reads bind current memberships while a space read stays single-space', async () => {
    const seen: string[][] = []
    const personal = {
      ...identity,
      memberships: [
        ...identity.memberships,
        { space_id: 'space-b', name: 'Space B', slug: 'space-b' },
      ],
    }
    const app = (session: RecordIdentity) =>
      appWith(session, {
        readProjects: async (input: { spaceIds: string[] }) => {
          seen.push(input.spaceIds)
          return []
        },
      })
    expect((await app(personal).request('/v1/projects')).status).toBe(200)
    expect(
      (
        await app({
          ...personal,
          memberships: identity.memberships,
        }).request('/v1/projects')
      ).status,
    ).toBe(200)
    expect(
      (await app({ ...personal, activeSpaceId: 'space-b' }).request('/v1/projects')).status,
    ).toBe(200)
    expect(seen).toEqual([['space-a', 'space-b'], ['space-a'], ['space-b']])
  })

  test('doc lists opt into readable spaces while the default stays active-space scoped', async () => {
    const seen: Array<{ spaceId: string; spaceIds: string[]; acrossReadableSpaces: boolean }> = []
    const personal = {
      ...identity,
      memberships: [
        ...identity.memberships,
        { space_id: 'space-b', name: 'Space B', slug: 'space-b' },
      ],
    }
    const app = appWith(personal, {
      listDocs: async (input: {
        spaceId: string
        spaceIds: string[]
        acrossReadableSpaces: boolean
      }) => {
        seen.push(input)
        return []
      },
    })

    expect((await app.request('/v1/docs')).status).toBe(200)
    expect((await app.request('/v1/docs?acrossReadableSpaces=true')).status).toBe(200)
    expect(seen).toEqual([
      expect.objectContaining({
        spaceId: 'space-a',
        spaceIds: ['space-a', 'space-b'],
        acrossReadableSpaces: false,
      }),
      expect.objectContaining({
        spaceId: 'space-a',
        spaceIds: ['space-a', 'space-b'],
        acrossReadableSpaces: true,
      }),
    ])
  })

  test('sets only a member space and refuses a non-member space', async () => {
    let selected = ''
    const member = appWith(identity, {
      setActiveSpace: async (_headers: Headers, spaceId: string) => {
        selected = spaceId
      },
    })
    const response = await member.request('/v1/active-space', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ spaceId: id }),
    })
    expect(response.status).toBe(200)
    expect(selected).toBe(id)

    const outsider = appWith(identity, {
      setActiveSpace: async () => {
        throw new Error(`record user is not a member of space ${id}`)
      },
    })
    const refused = await outsider.request('/v1/active-space', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ spaceId: id }),
    })
    expect(refused.status).toBe(403)
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
            : Response.json(
                { message: 'Too many requests. Please try again later.' },
                { status: 429 },
              )
        },
      },
    })
    const first = await app.request('/api/auth/request-password-reset', { method: 'POST' })
    const limited = await app.request('/api/auth/request-password-reset', { method: 'POST' })
    expect(limited.status).toBe(first.status)
    expect(await limited.json()).toEqual(await first.json())
  })
})

describe('record config API', () => {
  test('secret listing is metadata-only and secret reads encode opaque envelopes', async () => {
    const metadata = {
      key: 'token',
      environment: 'default',
      scope: 'user' as const,
      dekId: id,
      rowVersion: 1,
      updatedAt: '2026-09-18T12:00:00.000Z',
    }
    const app = appWith(identity, {
      listConfigSecrets: async () => [metadata],
      getConfigSecret: async () => ({ ...metadata, envelope: Uint8Array.of(251, 255) }),
    })
    const listed = await (await app.request('/v1/config/secrets?environment=default')).json()
    expect(listed).toEqual({ items: [metadata] })
    expect(JSON.stringify(listed)).not.toContain('-_8')

    const read = await (
      await app.request('/v1/config/secrets/token?environment=default&scope=user')
    ).json()
    expect(read).toEqual({ ...metadata, envelope: '-_8' })
  })

  test('config bodies use 422 and never echo rejected ciphertext', async () => {
    const envelope = 'sensitive-envelope='
    const response = await appWith(identity).request('/v1/config/secrets/token', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        environment: 'default',
        scope: 'user',
        dekId: id,
        envelope,
        expectedRowVersion: null,
      }),
    })
    expect(response.status).toBe(422)
    expect(JSON.stringify(await response.json())).not.toContain(envelope)
  })

  test('current data key requires the documented recipientKeyId query parameter', async () => {
    const response = await appWith(identity).request('/v1/config/data-keys/current')
    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({ error: 'invalid recipient key id' })
  })

  test('data key creation accepts a validated client id and passes it through', async () => {
    let received: Record<string, unknown> | undefined
    const response = await appWith(identity, {
      createDataKey: async (input: Record<string, unknown>) => {
        received = input
        return { id, version: 1 }
      },
    }).request('/v1/config/data-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dekId: id, version: 1, wraps: [] }),
    })
    expect(response.status).toBe(200)
    expect(received).toMatchObject({ dekId: id, version: 1, spaceId: 'space-a' })
  })

  test('data key by id filters wraps through the named recipient', async () => {
    let received: Record<string, unknown> | undefined
    const response = await appWith(identity, {
      getDataKey: async (input: Record<string, unknown>) => {
        received = input
        return { id, version: 1, createdAt: '2026-09-18T12:00:00.000Z', retiredAt: null, wraps: [] }
      },
    }).request(`/v1/config/data-keys/${id}?recipientKeyId=AAAAAAAAAAAAAAAAAAAAAA`)
    expect(response.status).toBe(200)
    expect(received).toMatchObject({ dekId: id, recipientKeyId: 'AAAAAAAAAAAAAAAAAAAAAA' })
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

  test('validates run window inputs and passes the accepted query', async () => {
    let received: Record<string, unknown> = {}
    const app = appWith(identity, {
      readRunsWindow: async (input: Record<string, unknown>) => {
        received = input
        return {
          items: [],
          matched: 0,
          offset: input.offset,
          limit: input.limit,
          facets: { agents: [], projects: [] },
          totals: { runs: 0, scored: 0, voided: 0, failed: 0 },
          vendors: [],
          unscored: 0,
          live: [],
        }
      },
    })
    expect((await app.request('/v1/runs/window?hours=12')).status).toBe(400)
    expect((await app.request('/v1/runs/window?hours=24&limit=20')).status).toBe(400)
    expect((await app.request(`/v1/runs/window?hours=24&search=${'x'.repeat(201)}`)).status).toBe(
      400,
    )
    expect(
      (await app.request('/v1/runs/window?hours=168&project=p&agent=a&offset=25&limit=25')).status,
    ).toBe(200)
    expect(received).toMatchObject({
      hours: 168,
      project: 'p',
      agent: 'a',
      search: '',
      offset: 25,
      limit: 25,
    })
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
