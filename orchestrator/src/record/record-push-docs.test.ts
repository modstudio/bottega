import { describe, expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record/schema.ts'
import { installRecordApiClient, unusedBoardClientMethods } from '../../test/fixtures/record-api.ts'
import { db, writableDb } from '../database/db.ts'
import type { RecordApiClient, RecordDocImportInput } from './record-api-client.ts'
import { groupLocalDocsForImport, pushDocsCommand } from './record-push-docs.ts'

const OLD = '2026-01-01T00:00:00.000Z'
const MID = '2026-01-01T12:00:00.000Z'
const NEW = '2026-01-02T00:00:00.000Z'

function insertProject(name: string): number {
  writableDb()
  return (
    db()
      .query<{ id: number }, [string]>(
        "INSERT INTO project (name, path, canon, settings) VALUES (?, '/tmp/p', 1, '{}') RETURNING id",
      )
      .get(name) as { id: number }
  ).id
}

function insertDoc(row: {
  scope: string
  subject: string | null
  slug: string
  title: string
  body: string
  delivery: 'inject' | 'demand'
  projectId?: number | null
  createdAt: string
  updatedAt: string
  parentId?: number | null
}): number {
  writableDb()
  return (
    db()
      .query(
        `INSERT INTO doc (scope, subject, project_id, slug, title, body, delivery, created_at, updated_at, parent_id)
         VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING id`,
      )
      .get(
        row.scope,
        row.subject,
        row.projectId ?? null,
        row.slug,
        row.title,
        row.body,
        row.delivery,
        row.createdAt,
        row.updatedAt,
        row.parentId ?? null,
      ) as { id: number }
  ).id
}

function insertRevision(row: {
  docId: number
  scope: string
  subject: string | null
  slug: string
  op: string
  title: string
  body: string
  delivery: 'inject' | 'demand'
  author?: string
  reason: string
  sessionId?: string | null
  at: string
  projectId?: number | null
  parentId?: number | null
}): number {
  writableDb()
  return (
    db()
      .query(
        `INSERT INTO doc_revision
         (doc_id, scope, subject, project_id, slug, op, title, body, delivery, author, reason, session_id, at, parent_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
      )
      .get(
        row.docId,
        row.scope,
        row.subject,
        row.projectId ?? null,
        row.slug,
        row.op,
        row.title,
        row.body,
        row.delivery,
        row.author ?? 'author',
        row.reason,
        row.sessionId ?? null,
        row.at,
        row.parentId ?? null,
      ) as { id: number }
  ).id
}

function unused(): Promise<never> {
  return Promise.reject(new Error('unused'))
}

function capturingClient(overrides: Partial<RecordApiClient> = {}): {
  client: RecordApiClient
  imports: RecordDocImportInput[]
} {
  const imports: RecordDocImportInput[] = []
  const hosted = new Map<string, Record<string, unknown>>()
  const client: RecordApiClient = {
    ...unusedBoardClientMethods(),
    applySettingsPermission: unused,
    inviteMember: unused,
    putSnapshot: unused,
    listSnapshots: unused,
    listDocs: unused,
    getDoc: async (id) => {
      const doc = hosted.get(id)
      if (!doc) throw new Error('doc not found')
      return doc
    },
    listRevisions: unused,
    upsertDoc: unused,
    importDoc: async (input) => {
      imports.push(structuredClone(input))
      const id = input.doc.id!
      const revisionIds = input.revisions.map(() => newRecordId())
      hosted.set(id, { ...input.doc })
      return { id, revisionIds }
    },
    importCanon: unused,
    deleteDoc: unused,
    consumeDoc: unused,
    restoreDoc: unused,
    renameSubject: unused,
    upsertProject: unused,
    retireProject: unused,
    putScore: unused,
    voidRun: unused,
    unvoidRun: unused,
    listScores: unused,
    counts: async () => ({
      docs: hosted.size,
      revisions: imports.flatMap((row) => row.revisions).length,
      scores: 0,
      voids: 0,
    }),
    ...overrides,
    whoami: overrides.whoami ?? unused,
  }
  return { client, imports }
}

describe('record push-docs grouping', () => {
  test('builds a deleted doc from orphaned revisions and keeps the live body', () => {
    const projectId = insertProject('widget')
    const liveId = insertDoc({
      scope: 'machine',
      subject: null,
      slug: 'live',
      title: 'Live',
      body: 'current',
      delivery: 'inject',
      createdAt: OLD,
      updatedAt: NEW,
    })
    insertRevision({
      docId: liveId,
      scope: 'machine',
      subject: null,
      slug: 'live',
      op: 'create',
      title: 'Live',
      body: 'old',
      delivery: 'inject',
      reason: 'create live',
      at: OLD,
    })
    insertRevision({
      docId: liveId,
      scope: 'machine',
      subject: null,
      slug: 'live',
      op: 'set',
      title: 'Live',
      body: 'stale',
      delivery: 'inject',
      reason: 'historical set',
      at: MID,
    })
    const goneId = insertDoc({
      scope: 'project',
      subject: 'widget',
      slug: 'gone',
      title: 'Gone',
      body: 'before-delete',
      delivery: 'demand',
      projectId,
      createdAt: OLD,
      updatedAt: NEW,
    })
    insertRevision({
      docId: goneId,
      scope: 'project',
      subject: 'widget',
      slug: 'gone',
      op: 'create',
      title: 'Gone',
      body: 'first',
      delivery: 'demand',
      reason: 'create gone',
      at: OLD,
      projectId,
    })
    insertRevision({
      docId: goneId,
      scope: 'project',
      subject: 'widget',
      slug: 'gone',
      op: 'delete',
      title: 'Gone',
      body: 'before-delete',
      delivery: 'demand',
      reason: 'remove gone',
      at: NEW,
      projectId,
    })
    db().query('DELETE FROM doc WHERE id=?').run(goneId)

    const groups = groupLocalDocsForImport()
    const live = groups.find((group) => group.payload.doc.slug === 'live')
    const gone = groups.find((group) => group.payload.doc.slug === 'gone')
    expect(live?.payload.doc.body).toBe('current')
    expect(live?.payload.doc.deletedAt).toBeNull()
    expect(live?.payload.revisions.map((row) => row.body)).toEqual(['old', 'stale'])
    expect(gone?.localDocId).toBeNull()
    expect(gone?.payload.doc.body).toBe('before-delete')
    expect(gone?.payload.doc.deletedAt).toBe(NEW)
    expect(gone?.payload.doc.projectName).toBe('widget')
    expect(gone?.payload.doc.title).toBe('Gone')
  })
})

describe('record push-docs command', () => {
  test('uses the hosted parent id returned by an earlier import for child and revision', async () => {
    const parentId = insertDoc({
      scope: 'global',
      subject: null,
      slug: 'parent',
      title: 'Parent',
      body: 'parent',
      delivery: 'demand',
      createdAt: OLD,
      updatedAt: NEW,
    })
    insertRevision({
      docId: parentId,
      scope: 'global',
      subject: null,
      slug: 'parent',
      op: 'create',
      title: 'Parent',
      body: 'parent',
      delivery: 'demand',
      reason: 'create parent',
      at: OLD,
    })
    const childId = insertDoc({
      scope: 'global',
      subject: null,
      slug: 'child',
      title: 'Child',
      body: 'child',
      delivery: 'demand',
      createdAt: OLD,
      updatedAt: NEW,
      parentId,
    })
    insertRevision({
      docId: childId,
      scope: 'global',
      subject: null,
      slug: 'child',
      op: 'create',
      title: 'Child',
      body: 'child',
      delivery: 'demand',
      reason: 'create child',
      at: OLD,
      parentId,
    })
    const returnedParentId = newRecordId()
    const { client, imports } = capturingClient({
      importDoc: async (input) => {
        imports.push(structuredClone(input))
        return {
          id: input.doc.slug === 'parent' ? returnedParentId : input.doc.id!,
          revisionIds: input.revisions.map(() => newRecordId()),
        }
      },
      getDoc: async (hostedId) => ({
        id: hostedId,
        body: hostedId === returnedParentId ? 'parent' : 'child',
        delivery: 'demand',
        deletedAt: null,
      }),
      counts: async () => ({ docs: 2, revisions: 2, scores: 0, voids: 0 }),
    })
    installRecordApiClient(client)

    await pushDocsCommand({ dryRun: false }, { log: () => undefined })

    expect(imports.map((input) => input.doc.slug)).toEqual(['parent', 'child'])
    expect(imports[1]?.doc.parentId).toBe(returnedParentId)
    expect(imports[1]?.revisions[0]?.parentId).toBe(returnedParentId)
  })

  test('dry-run prints deleted count and does not import', async () => {
    const liveId = insertDoc({
      scope: 'machine',
      subject: null,
      slug: 'kept',
      title: 'Kept',
      body: 'now',
      delivery: 'inject',
      createdAt: OLD,
      updatedAt: NEW,
    })
    insertRevision({
      docId: liveId,
      scope: 'machine',
      subject: null,
      slug: 'kept',
      op: 'create',
      title: 'Kept',
      body: 'now',
      delivery: 'inject',
      reason: 'create kept',
      at: OLD,
    })
    const goneId = insertDoc({
      scope: 'machine',
      subject: null,
      slug: 'removed',
      title: 'Removed',
      body: 'gone',
      delivery: 'inject',
      createdAt: OLD,
      updatedAt: NEW,
    })
    insertRevision({
      docId: goneId,
      scope: 'machine',
      subject: null,
      slug: 'removed',
      op: 'delete',
      title: 'Removed',
      body: 'gone',
      delivery: 'inject',
      reason: 'remove it',
      at: NEW,
    })
    db().query('DELETE FROM doc WHERE id=?').run(goneId)
    const { client, imports } = capturingClient()
    installRecordApiClient(client)
    const lines: string[] = []
    await pushDocsCommand({ dryRun: true }, { log: (value) => lines.push(value) })
    expect(imports).toEqual([])
    expect(lines.some((line) => line.includes('deleted 1'))).toBe(true)
  })

  test('sends one import per doc and records returned ids', async () => {
    const liveId = insertDoc({
      scope: 'machine',
      subject: null,
      slug: 'live',
      title: 'Live',
      body: 'current',
      delivery: 'inject',
      createdAt: OLD,
      updatedAt: NEW,
    })
    insertRevision({
      docId: liveId,
      scope: 'machine',
      subject: null,
      slug: 'live',
      op: 'create',
      title: 'Live',
      body: 'old',
      delivery: 'inject',
      reason: 'create live',
      at: OLD,
    })
    const goneId = insertDoc({
      scope: 'machine',
      subject: null,
      slug: 'gone',
      title: 'Gone',
      body: 'before-delete',
      delivery: 'inject',
      createdAt: OLD,
      updatedAt: NEW,
    })
    insertRevision({
      docId: goneId,
      scope: 'machine',
      subject: null,
      slug: 'gone',
      op: 'delete',
      title: 'Gone',
      body: 'before-delete',
      delivery: 'inject',
      reason: 'remove gone',
      at: NEW,
    })
    db().query('DELETE FROM doc WHERE id=?').run(goneId)
    const { client, imports } = capturingClient()
    installRecordApiClient(client)
    await pushDocsCommand({ dryRun: false }, { log: () => undefined })
    expect(imports).toHaveLength(2)
    const live = imports.find((row) => row.doc.slug === 'live')
    const gone = imports.find((row) => row.doc.slug === 'gone')
    expect(live?.doc.body).toBe('current')
    expect(live?.revisions[0]?.body).toBe('old')
    expect(gone?.doc.deletedAt).toBe(NEW)
    expect(gone?.doc.body).toBe('before-delete')
    const stored = db()
      .query<{ record_id: string | null }, []>("SELECT record_id FROM doc WHERE slug='live'")
      .get()
    expect(stored?.record_id).toBeString()
  })

  test('comparison detects body, delivery, and deleted_at mismatches', async () => {
    const liveId = insertDoc({
      scope: 'machine',
      subject: null,
      slug: 'live',
      title: 'Live',
      body: 'current',
      delivery: 'inject',
      createdAt: OLD,
      updatedAt: NEW,
    })
    insertRevision({
      docId: liveId,
      scope: 'machine',
      subject: null,
      slug: 'live',
      op: 'create',
      title: 'Live',
      body: 'current',
      delivery: 'inject',
      reason: 'create live',
      at: OLD,
    })
    const { client } = capturingClient({
      getDoc: async (id) => ({
        id,
        body: 'other',
        delivery: 'demand',
        deletedAt: NEW,
      }),
    })
    installRecordApiClient(client)
    const lines: string[] = []
    await expect(
      pushDocsCommand({ dryRun: false }, { log: (value) => lines.push(value) }),
    ).rejects.toThrow('hosted docs do not match local live docs')
    expect(lines.some((line) => line.includes('body hash'))).toBe(true)
    expect(lines.some((line) => line.includes('delivery inject != demand'))).toBe(true)
    expect(lines.some((line) => line.includes(`deleted_at ${NEW}`))).toBe(true)
  })
})
