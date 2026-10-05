import { expect, test } from 'bun:test'
import { SQL } from 'bun'
import { newRecordId } from '../../../shared/record/schema.ts'
import { idleBoardDeps } from '../../test/fixtures/record-api.ts'
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
    upsertProject: async () => ({ name: 'one' }),
    retireProject: async () => ({ name: 'one' }),
    listDocs: async () => [],
    readDoc: async () => null,
    listDocRevisions: async () => [],
    upsertDoc: async () => ({ id: 'x', revisionId: 'x' }),
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
    ...idleBoardDeps(),
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

test('board changes query refuses a non-integer after cursor', async () => {
  const app = appWith(identity)
  const response = await app.request('/v1/board/changes?after=abc')
  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({ error: 'invalid board changes query' })
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
