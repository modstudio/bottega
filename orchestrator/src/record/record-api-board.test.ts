import { expect, test } from 'bun:test'
import { SQL } from 'bun'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record/schema.ts'
import { idleRecordApiDeps, idleSubjectDeps } from '../../test/fixtures/record-api.ts'
import { recordApi } from './record-api.ts'
import type { RecordIdentity } from './record-auth.ts'

const identity: RecordIdentity = {
  user: { id: 'user-a', email: 'a@example.test' },
  activeSpaceId: 'space-a',
  personalSpaceId: 'space-personal',
  memberships: [
    { space_id: 'space-a', name: 'A', slug: 'a', role: 'owner', permission: 'write' },
    { space_id: 'space-b', name: 'B', slug: 'b', role: 'member', permission: 'write' },
  ],
}

function appWith(session: RecordIdentity | null, overrides: Record<string, unknown> = {}) {
  return recordApi({
    recordUrl: 'postgres://record.test/record',
    auth: { handler: () => Response.json({ handled: true }) },
    readSession: async () => session,
    setActiveSpace: async () => undefined,
    readHealth: async () => ({ ok: true, migrations: 14 }),
    readCommit: () => undefined,
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
    listRoutingEvidence: async () => [],
    readReviews: async () => [],
    readReview: async () => null,
    readReleases: async () => [],
    readLatestReleases: async () => [],
    readProjects: async () => [],
    upsertProject: async () => ({ id: newRecordId(), name: 'one' }),
    retireProject: async () => ({ name: 'one' }),
    listDocs: async () => [],
    listPublicDocs: async () => [],
    readPublicDoc: async () => null,
    searchPublicDocs: async () => [],
    searchDocs: async () => [],
    readDoc: async () => null,
    listDocRevisions: async () => [],
    upsertDoc: async () => ({ id: 'x', revisionId: 'x' }),
    reorderDocs: async ({ orderedIds }) => ({ orderedIds }),
    importDoc: async () => ({ id: 'x', revisionIds: ['x'] }),
    importCanon: async () => ({ rows: [], deletions: [], findings: [], bootstrap: false }),
    deleteDoc: async () => ({ id: 'x', revisionId: 'x' }),
    consumeDoc: async () => ({ id: 'x', revisionId: 'x', alreadyConsumed: false }),
    restoreDoc: async () => ({ id: 'x', revisionId: 'x' }),
    renameDocSubject: async () => ({ docs: 0, revisions: 0 }),
    countDocs: async () => ({ docs: 0, revisions: 0 }),
    applySettingsPermission: async () => ({
      revision: 'x',
      permissions: { allow: [], ask: [], deny: [] },
    }),
    applySettingsAutoMode: async () => ({
      revision: 'x',
      autoMode: { allow: [], soft_deny: [], hard_deny: [], environment: [] },
    }),
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
    createDataKey: async () => ({ id: 'x', version: 1 }),
    addDataKeyWraps: async () => undefined,
    retireDataKey: async () => undefined,
    deleteDataKeyWraps: async () => undefined,
    listMachineKeys: async () => [],
    registerMachineKey: async () => {
      throw new Error('not implemented')
    },
    revokeMachineKey: async () => undefined,
    ...idleSubjectDeps(),
    ...idleRecordApiDeps(),
    ...overrides,
  })
}

const expiresAt = '2026-10-06T00:00:00.000Z'
test('board post refuses an invalid body at the route edge', async () => {
  const app = appWith(identity)
  const response = await app.request('/v1/board/messages', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'notice' }),
  })
  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({ error: 'invalid board message' })
})

test('board post refuses misspelled text without calling the hosted write', async () => {
  let writes = 0
  const misspelling = ['me', 'ida'].join('')
  const app = appWith(identity, {
    postBoardMessage: async () => {
      writes += 1
      return { id: newRecordId() }
    },
  })
  const response = await app.request('/v1/board/messages', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: newRecordId(),
      kind: 'notice',
      audience: 'operator',
      title: 'Hosted prose',
      body: `We saw the ${misspelling} here.`,
      expiresAt,
    }),
  })
  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({
    error: expect.stringContaining(`body:\n"${misspelling}"`),
  })
  expect(writes).toBe(0)
})

test('board post accepts every purpose, defaults a missing purpose, and refuses an unknown purpose', async () => {
  const purposes: string[] = []
  const app = appWith(identity, {
    postBoardMessage: async (input: { id: string; purpose: string }) => {
      purposes.push(input.purpose)
      return { id: input.id }
    },
  })
  const post = (purpose?: string, ackRequired = false) =>
    app.request('/v1/board/messages', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-record-space': 'space-a' },
      body: JSON.stringify({
        id: newRecordId(),
        kind: 'notice',
        audience: 'operator',
        title: 'Purpose',
        body: 'Body',
        expiresAt,
        ...(ackRequired ? { ackRequired: true } : {}),
        ...(purpose === undefined ? {} : { purpose }),
      }),
    })
  for (const purpose of ['information', 'request', 'standing'])
    expect((await post(purpose)).status).toBe(200)
  expect((await post()).status).toBe(200)
  expect((await post(undefined, true)).status).toBe(200)
  const unknown = await post('unknown')
  expect(unknown.status).toBe(400)
  expect(await unknown.json()).toEqual({ error: 'invalid board message' })
  expect(purposes).toEqual(['information', 'request', 'standing', 'information', 'request'])
})

test('board status binds the caller tenant and returns the service view', async () => {
  const id = newRecordId()
  const expected = { message: { id }, receipts: [] }
  const app = appWith(identity, {
    boardStatus: async (input: { id: string; userId: string; spaceIds: string[] }) => {
      expect(input).toMatchObject({ id, userId: identity.user.id })
      expect(input.spaceIds).toEqual(['space-a', 'space-b'])
      return expected
    },
  })
  const response = await app.request(`/v1/board/messages/${id}/status`)
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual(expected)
})

test('board list validates filters and binds every caller space', async () => {
  const expected = { messages: [], truncated: false }
  const app = appWith(identity, {
    listBoardMessages: async (input: {
      userId: string
      spaceIds: string[]
      kind?: string
      open?: boolean
      includeEnded?: boolean
      ownTitlePrefix?: string
    }) => {
      expect(input).toMatchObject({
        userId: identity.user.id,
        kind: 'question',
        open: true,
        includeEnded: false,
        ownTitlePrefix: 'Hosted pressure: %_',
      })
      expect(input.spaceIds).toEqual(['space-a', 'space-b'])
      return expected
    },
  })
  const response = await app.request(
    '/v1/board/messages?kind=question&open=true&includeEnded=false&ownTitlePrefix=Hosted%20pressure%3A%20%25_',
  )
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual(expected)

  const invalid = await app.request('/v1/board/messages?open=maybe')
  expect(invalid.status).toBe(400)
  expect(await invalid.json()).toEqual({ error: 'invalid board messages query' })
})

test('board post refuses caller recipientUserIds and claimId at the route edge', async () => {
  const app = appWith(identity)
  const base = {
    id: newRecordId(),
    kind: 'notice',
    audience: 'operator',
    title: 'Hi',
    body: 'There',
    expiresAt,
  }
  const withRecipients = await app.request('/v1/board/messages', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...base, recipientUserIds: [newRecordId()] }),
  })
  const withClaim = await app.request('/v1/board/messages', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...base, id: newRecordId(), claimId: newRecordId() }),
  })
  expect(withRecipients.status).toBe(400)
  expect(await withRecipients.json()).toEqual({ error: 'invalid board message' })
  expect(withClaim.status).toBe(400)
  expect(await withClaim.json()).toEqual({ error: 'invalid board message' })
})

test('board routes bind every membership space, not only the active space', async () => {
  const captured: string[][] = []
  const app = appWith(identity, {
    postBoardMessage: async (input: { spaceIds: string[] }) => {
      captured.push(input.spaceIds)
      return { id: input && 'id' }
    },
  })
  const response = await app.request('/v1/board/messages', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: newRecordId(),
      kind: 'notice',
      audience: 'operator',
      title: 'Hi',
      body: 'There',
      expiresAt,
    }),
  })
  expect(response.status).toBe(200)
  expect(captured[0]).toEqual(['space-a', 'space-b'])
})

test('a personal active space does not narrow project-addressed posts or task claims', async () => {
  const personalActive = { ...identity, activeSpaceId: identity.personalSpaceId }
  const calls: { kind: string; project: string; spaceIds: string[] }[] = []
  const app = appWith(personalActive, {
    postBoardMessage: async (input: { id: string; project: string; spaceIds: string[] }) => {
      calls.push({ kind: 'post', project: input.project, spaceIds: input.spaceIds })
      return { id: input.id }
    },
    takeBoardClaim: async (input: { project: string; spaceIds: string[] }) => {
      calls.push({ kind: 'claim', project: input.project, spaceIds: input.spaceIds })
      return { id: newRecordId(), action: 'taken' }
    },
  })
  const post = await app.request('/v1/board/messages', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-record-space': 'space-b' },
    body: JSON.stringify({
      id: newRecordId(),
      kind: 'notice',
      audience: 'architects',
      title: 'Project notice',
      body: 'Visible to the project.',
      expiresAt,
      authorSession: 'first-session',
      authorHarness: 'claude',
      project: PLATFORM_SLUG,
    }),
  })
  const claim = await app.request('/v1/board/claims', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-record-space': 'space-b' },
    body: JSON.stringify({
      id: newRecordId(),
      project: PLATFORM_SLUG,
      projectId: newRecordId(),
      subject: 'task:DEV-2241',
      holderSession: 'first-session',
      durationMs: 60_000,
    }),
  })
  expect([post.status, claim.status]).toEqual([200, 200])
  expect(calls).toEqual([
    { kind: 'post', project: PLATFORM_SLUG, spaceIds: ['space-a', 'space-b'] },
    { kind: 'claim', project: PLATFORM_SLUG, spaceIds: ['space-a', 'space-b'] },
  ])
})

test('board post, reply, claim, and read work without an active space', async () => {
  const noActiveSpace = { ...identity, activeSpaceId: null }
  const bound: Array<{ route: string; spaceId: string; spaceIds: string[] }> = []
  const capture = (route: string, input: { spaceId: string; spaceIds: string[] }) => {
    bound.push({ route, spaceId: input.spaceId, spaceIds: input.spaceIds })
  }
  const app = appWith(noActiveSpace, {
    postBoardMessage: async (input: { id: string; spaceId: string; spaceIds: string[] }) => {
      capture('post', input)
      return { id: input.id }
    },
    replyBoardMessage: async (input: { id: string; spaceId: string; spaceIds: string[] }) => {
      capture('reply', input)
      return { id: input.id }
    },
    takeBoardClaim: async (input: { spaceId: string; spaceIds: string[] }) => {
      capture('claim', input)
      return { id: newRecordId(), action: 'taken' }
    },
    listBoardMessages: async (input: { spaceId: string; spaceIds: string[] }) => {
      capture('read', input)
      return { messages: [], truncated: false }
    },
  })
  const rootId = newRecordId()
  const responses = await Promise.all([
    app.request('/v1/board/messages', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-record-space': 'space-a' },
      body: JSON.stringify({
        id: newRecordId(),
        kind: 'notice',
        audience: 'architects',
        title: 'No active space',
        body: 'The project still addresses this message.',
        expiresAt,
        authorSession: 'session-a',
        project: PLATFORM_SLUG,
      }),
    }),
    app.request(`/v1/board/messages/${rootId}/replies`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-record-space': 'space-a' },
      body: JSON.stringify({ id: newRecordId(), body: 'Reply', authorSession: 'session-a' }),
    }),
    app.request('/v1/board/claims', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-record-space': 'space-a' },
      body: JSON.stringify({
        id: newRecordId(),
        project: PLATFORM_SLUG,
        projectId: newRecordId(),
        subject: 'task:DEV-2241',
        holderSession: 'session-a',
      }),
    }),
    app.request('/v1/board/messages'),
  ])
  expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200])
  expect(bound.sort((left, right) => left.route.localeCompare(right.route))).toEqual([
    { route: 'claim', spaceId: 'space-a', spaceIds: ['space-a', 'space-b'] },
    { route: 'post', spaceId: 'space-a', spaceIds: ['space-a', 'space-b'] },
    { route: 'read', spaceId: 'space-personal', spaceIds: ['space-a', 'space-b'] },
    { route: 'reply', spaceId: 'space-a', spaceIds: ['space-a', 'space-b'] },
  ])
})

test('board presence binds a named member space and refuses a non-member space', async () => {
  const spaces: string[] = []
  const app = appWith(
    { ...identity, activeSpaceId: identity.personalSpaceId },
    {
      listBoardChanges: async (input: { spaceId: string }) => {
        spaces.push(input.spaceId)
        return { userId: identity.user.id, items: [], highestRevision: null }
      },
    },
  )
  const present = await app.request('/v1/board/changes?after=0', {
    headers: { 'x-record-space': 'space-b' },
  })
  expect(present.status).toBe(200)
  expect(spaces).toEqual(['space-b'])
  const refused = await app.request('/v1/board/changes?after=0', {
    headers: { 'x-record-space': 'space-foreign' },
  })
  expect(refused.status).toBe(403)
  expect(await refused.json()).toEqual({
    error: 'signed-in user is not a member of record space space-foreign',
    remedy: expect.stringContaining('an invitation from a member of that space is needed'),
  })
  const refusedWrite = await app.request('/v1/board/messages', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-record-space': 'space-foreign' },
    body: JSON.stringify({}),
  })
  expect(refusedWrite.status).toBe(403)
  expect(await refusedWrite.json()).toEqual({
    error: 'signed-in user is not a member of record space space-foreign',
    remedy: expect.stringContaining('an invitation from a member of that space is needed'),
  })
})

test('board changes query refuses a non-integer after cursor', async () => {
  const app = appWith(identity)
  const response = await app.request('/v1/board/changes?after=abc')
  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({ error: 'invalid board changes query' })
})

test('board stream binds the caller tenant and sends its visible head immediately', async () => {
  const app = appWith(identity, {
    readBoardHead: async (input: { userId: string; spaceIds: string[] }) => {
      expect(input.userId).toBe(identity.user.id)
      expect(input.spaceIds).toEqual(['space-a', 'space-b'])
      return '42'
    },
  })
  const response = await app.request('/v1/board/stream')
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toBe('text/event-stream')
  const reader = response.body!.getReader()
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('id: 42')
  await reader.cancel()
})

test('board stream re-resolves the caller tenant before every head read', async () => {
  const listeners = new Set<() => void>()
  let sessionReads = 0
  let headReads = 0
  const app = appWith(identity, {
    readSession: async () => (++sessionReads <= 2 ? identity : null),
    boardWakeSource: {
      subscribe(listener: () => void) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    readBoardHead: async () => {
      headReads++
      return '42'
    },
  })
  const response = await app.request('/v1/board/stream')
  const reader = response.body!.getReader()
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('id: 42')
  for (const listener of listeners) listener()
  expect((await reader.read()).done).toBe(true)
  expect(sessionReads).toBe(3)
  expect(headReads).toBe(1)
})

test('a board trigger exception is a named refusal not a server error', async () => {
  const app = appWith(identity, {
    replyBoardMessage: async () => {
      throw new SQL.PostgresError('board reply scope and recipients must match thread root', {
        code: 'ERR_POSTGRES_SERVER_ERROR',
        errno: 'P0001',
      })
    },
  })
  const response = await app.request(`/v1/board/messages/${newRecordId()}/replies`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: newRecordId(), body: 'Answer' }),
  })
  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({
    error: 'board reply scope and recipients must match thread root',
  })
})

test('board reply rejects an unsupported audience at the route edge', async () => {
  const app = appWith(identity)
  const response = await app.request(`/v1/board/messages/${newRecordId()}/replies`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: newRecordId(), body: 'Answer', audience: 'project:other' }),
  })
  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({ error: 'invalid board reply' })
})

test('board reply refuses misspelled text without calling the hosted write', async () => {
  let writes = 0
  const misspelling = ['me', 'ida'].join('')
  const app = appWith(identity, {
    replyBoardMessage: async () => {
      writes += 1
      return { id: newRecordId() }
    },
  })
  const response = await app.request(`/v1/board/messages/${newRecordId()}/replies`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: newRecordId(), body: `We saw the ${misspelling} here.` }),
  })
  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({
    error: expect.stringContaining(`body:\n"${misspelling}"`),
  })
  expect(writes).toBe(0)
})

test('a row-level security denial is a named refusal not a server error', async () => {
  const app = appWith(identity, {
    postBoardMessage: async () => {
      throw new SQL.PostgresError(
        'new row violates row-level security policy for table "board_message"',
        { code: 'ERR_POSTGRES_SERVER_ERROR', errno: 42501 as unknown as string },
      )
    },
  })
  const response = await app.request('/v1/board/messages', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: newRecordId(),
      kind: 'notice',
      audience: 'operator',
      title: 'Hi',
      body: 'There',
      expiresAt,
    }),
  })
  expect(response.status).toBe(400)
  expect(JSON.stringify(await response.json())).toContain('row-level security')
})
