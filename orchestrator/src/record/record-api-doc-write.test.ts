import { describe, expect, test } from 'bun:test'
import { PLATFORM_NAME } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { identity, idleRecordApiDeps, idleSubjectDeps } from '../../test/fixtures/record-api.ts'
import { recordApi } from './record-api.ts'

const notImplemented = () => Promise.reject(new Error('not implemented'))

const appWith = (session: typeof identity | null, overrides: Record<string, unknown> = {}) =>
  recordApi({
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
    upsertDoc: async () => ({ id, revisionId: id }),
    reorderDocs: async ({ orderedIds }) => ({ orderedIds }),
    importDoc: async () => ({ id, revisionIds: [id] }),
    importCanon: async () => ({ rows: [], deletions: [], findings: [], bootstrap: false }),
    deleteDoc: async () => ({ id, revisionId: id }),
    consumeDoc: async () => ({ id, revisionId: id, alreadyConsumed: false }),
    restoreDoc: async () => ({ id, revisionId: id }),
    renameDocSubject: async () => ({ docs: 0, revisions: 0 }),
    countDocs: async () => ({ docs: 0, revisions: 0 }),
    applySettingsPermission: async () => ({
      revision: id,
      permissions: { allow: [], ask: [], deny: [] },
    }),
    applySettingsAutoMode: async () => ({
      revision: id,
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
    putConfigEntry: notImplemented,
    deleteConfigEntry: async () => undefined,
    listConfigSecrets: async () => [],
    getConfigSecret: async () => null,
    putConfigSecret: notImplemented,
    deleteConfigSecret: async () => undefined,
    currentDataKey: async () => null,
    listDataKeys: async () => [],
    getDataKey: async () => null,
    createDataKey: async () => ({ id, version: 1 }),
    addDataKeyWraps: async () => undefined,
    retireDataKey: async () => undefined,
    deleteDataKeyWraps: async () => undefined,
    listMachineKeys: async () => [],
    registerMachineKey: notImplemented,
    revokeMachineKey: async () => undefined,
    ...idleSubjectDeps(),
    ...idleRecordApiDeps(),
    ...overrides,
  })

const id = '01990000-0000-7000-8000-000000000001'

describe('record API doc write refusals', () => {
  test('reorder forwards the tenant-bound complete sibling order', async () => {
    let received: Record<string, unknown> | null = null
    const app = appWith(identity, {
      reorderDocs: async (input: Record<string, unknown>) => {
        received = input
        return { orderedIds: input.orderedIds as string[] }
      },
    })
    const body = { scope: 'project', subject: PLATFORM_NAME, parentId: null, orderedIds: [id] }
    const response = await app.request('/v1/docs/order', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    expect(response.status).toBe(200)
    expect(received).toMatchObject({ ...body, userId: identity.user.id })
  })

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
