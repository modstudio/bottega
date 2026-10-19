import { describe, expect, test } from 'bun:test'
import { effectiveDocSummary } from '../../../shared/docs.ts'
import { newRecordId } from '../../../shared/record/schema.ts'
import {
  installRecordApiClient,
  unusedBoardClientMethods,
  unusedIdentityAndSpaceClientMethods,
} from '../../test/fixtures/record-api.ts'
import { db, writableDb } from '../database/db.ts'
import type { RecordApiClient, RecordDocImportInput } from './record-api-client.ts'
import { groupLocalDocsForImport, pushDocsCommand } from './record-push-docs.ts'

const OLD = '2026-01-01T00:00:00.000Z'
const MID = '2026-01-01T12:00:00.000Z'
const NEW = '2026-01-02T00:00:00.000Z'

function insertProject(name: string): string {
  writableDb()
  return (
    db()
      .query<{ record_id: string }, [string]>(
        "INSERT INTO project (record_id,name, path, canon, settings) VALUES (lower(hex(randomblob(4))) || char(45) || lower(hex(randomblob(2))) || char(45,55) || substr(lower(hex(randomblob(2))),2) || char(45,56) || substr(lower(hex(randomblob(2))),2) || char(45) || lower(hex(randomblob(6))),?, '/tmp/p', 1, '{}') RETURNING record_id",
      )
      .get(name) as { record_id: string }
  ).record_id
}

function insertDoc(row: {
  scope: string
  subject: string | null
  slug: string
  title: string
  body: string
  delivery: 'inject' | 'demand'
  projectId?: string | null
  createdAt: string
  updatedAt: string
  parentId?: string | null
}): string {
  writableDb()
  return (
    db()
      .query(
        `INSERT INTO doc (scope, subject, project_record_id, slug, title, body, delivery, audiences, created_at, updated_at, parent_record_id, record_id)
         VALUES (?,?,?,?,?,?,?,'["technical"]',?,?,?,?) RETURNING record_id`,
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
        newRecordId(),
      ) as { record_id: string }
  ).record_id
}

function insertRevision(row: {
  docId: string
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
  projectId?: string | null
  parentId?: string | null
}): string {
  writableDb()
  return (
    db()
      .query(
        `INSERT INTO doc_revision
         (record_id, number, doc_record_id, scope, subject, project_record_id, slug, op, title, body, delivery, audiences, author, reason, session_id, at, parent_record_id)
         VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM doc_revision),?,?,?,?,?,?,?,?,?,'["technical"]',?,?,?,?,?) RETURNING record_id`,
      )
      .get(
        newRecordId(),
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
      ) as { record_id: string }
  ).record_id
}

function unused(): Promise<never> {
  return Promise.reject(new Error('unused'))
}

function capturingClient(overrides: Partial<RecordApiClient> = {}): {
  client: RecordApiClient
  imports: RecordDocImportInput[]
  hosted: Map<string, Record<string, unknown>>
} {
  const imports: RecordDocImportInput[] = []
  const hosted = new Map<string, Record<string, unknown>>()
  const client: RecordApiClient = {
    ...unusedIdentityAndSpaceClientMethods(),
    ...unusedBoardClientMethods(),
    applySettingsPermission: unused,
    inviteMember: unused,
    putSnapshot: unused,
    listSnapshots: unused,
    listDocs: async () => ({
      items: [...hosted.entries()].map(([id, row]) => ({ id, ...row })),
      nextCursor: null,
    }),
    getDoc: async (id) => {
      const doc = hosted.get(id)
      if (!doc) throw new Error('doc not found')
      return doc
    },
    listRevisions: async (id) =>
      imports
        .filter((row) => row.doc.id === id)
        .flatMap((row) => row.revisions)
        .map((row) => ({ ...row })),
    upsertDoc: unused,
    reorderDocs: unused,
    importDoc: async (input) => {
      imports.push(structuredClone(input))
      const id = input.doc.id!
      const revisionIds = input.revisions.map((revision) => revision.id)
      hosted.set(id, {
        ...input.doc,
        ...effectiveDocSummary(input.doc.summary, input.doc.body),
      })
      return {
        id,
        revisionIds,
        form: input.doc.form ?? null,
        articleSubject: null,
        relatedSubjects: [],
        sourceFiles: input.doc.sourceFiles ?? [],
        checkedAgainstCommit: input.doc.checkedAgainstCommit ?? null,
        summary: input.doc.summary ?? null,
      }
    },
    importCanon: unused,
    deleteDoc: unused,
    consumeDoc: unused,
    restoreDoc: unused,
    renameSubject: unused,
    upsertProject: unused,
    listProjects: unused,
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
    whoami:
      overrides.whoami ??
      (async () => ({
        user: { id: newRecordId() },
        activeSpaceId: newRecordId(),
        personalSpaceId: newRecordId(),
        memberships: [],
      })),
  }
  return { client, imports, hosted }
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
    db().query('DELETE FROM doc WHERE record_id=?').run(goneId)

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
  test('refuses an older import response when the document carries an article field', async () => {
    const projectId = insertProject('article-import')
    const docId = insertDoc({
      scope: 'project',
      subject: 'article-import',
      slug: 'article',
      title: 'Article',
      body: 'Current.',
      delivery: 'demand',
      projectId,
      createdAt: OLD,
      updatedAt: NEW,
    })
    db()
      .query("UPDATE doc SET kind='article', source_files='[\"src/article.ts\"]' WHERE record_id=?")
      .run(docId)
    const { client } = capturingClient({
      importDoc: async (input) => ({
        id: input.doc.id!,
        revisionIds: input.revisions.map((revision) => revision.id),
      }),
    })
    installRecordApiClient(client)

    await expect(pushDocsCommand({ dryRun: false }, { log: () => undefined })).rejects.toThrow(
      'hosted API predates them',
    )
  })

  test('imports a superseded parent after its replacement and before its current child', async () => {
    const parentId = insertDoc({
      scope: 'global',
      subject: null,
      slug: 'old-parent',
      title: 'Old parent',
      body: 'old parent',
      delivery: 'demand',
      createdAt: OLD,
      updatedAt: NEW,
    })
    insertRevision({
      docId: parentId,
      scope: 'global',
      subject: null,
      slug: 'old-parent',
      op: 'set',
      title: 'Old parent',
      body: 'old parent',
      delivery: 'demand',
      reason: 'replace parent',
      at: NEW,
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
    const replacementId = insertDoc({
      scope: 'global',
      subject: null,
      slug: 'new-parent',
      title: 'New parent',
      body: 'new parent',
      delivery: 'demand',
      createdAt: OLD,
      updatedAt: NEW,
    })
    insertRevision({
      docId: replacementId,
      scope: 'global',
      subject: null,
      slug: 'new-parent',
      op: 'create',
      title: 'New parent',
      body: 'new parent',
      delivery: 'demand',
      reason: 'create replacement',
      at: OLD,
    })
    db()
      .query("UPDATE doc SET status='superseded', replacement_slug='new-parent' WHERE record_id=?")
      .run(parentId)

    const { client, imports } = capturingClient()
    installRecordApiClient(client)
    await pushDocsCommand({ dryRun: false }, { log: () => undefined })

    expect(imports.map((input) => input.doc.slug)).toEqual(['new-parent', 'old-parent', 'child'])
  })

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
    const returnedParentId = parentId
    const { client, imports } = capturingClient({
      importDoc: async (input) => {
        imports.push(structuredClone(input))
        return {
          id: input.doc.slug === 'parent' ? returnedParentId : input.doc.id!,
          revisionIds: input.revisions.map((revision) => revision.id),
          form: null,
          articleSubject: null,
          relatedSubjects: [],
          sourceFiles: [],
          checkedAgainstCommit: null,
          summary: null,
        }
      },
      getDoc: async (hostedId) => ({
        id: hostedId,
        body: hostedId === returnedParentId ? 'parent' : 'child',
        delivery: 'demand',
        status: 'current',
        kind: 'working',
        replacementSlug: null,
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
    db().query('DELETE FROM doc WHERE record_id=?').run(goneId)
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
    db().query('DELETE FROM doc WHERE record_id=?').run(goneId)
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
    const firstDeletedId = gone?.doc.id
    await pushDocsCommand({ dryRun: false }, { log: () => undefined })
    const replayedGone = imports.slice(2).find((row) => row.doc.slug === 'gone')
    expect(replayedGone?.doc.id).toBe(firstDeletedId)
    expect(replayedGone?.revisions.map((row) => row.id)).toEqual(
      gone?.revisions.map((row) => row.id),
    )
    const stored = db()
      .query<{ record_id: string | null }, []>("SELECT record_id FROM doc WHERE slug='live'")
      .get()
    expect(stored?.record_id).toBeString()
  })

  test('finds a deleted document identity on a later hosted page', async () => {
    const goneId = insertDoc({
      scope: 'machine',
      subject: null,
      slug: 'paged-gone',
      title: 'Paged gone',
      body: 'before-delete',
      delivery: 'inject',
      createdAt: OLD,
      updatedAt: NEW,
    })
    const revisionId = insertRevision({
      docId: goneId,
      scope: 'machine',
      subject: null,
      slug: 'paged-gone',
      op: 'delete',
      title: 'Paged gone',
      body: 'before-delete',
      delivery: 'inject',
      reason: 'remove paged doc',
      at: NEW,
    })
    db().query('DELETE FROM doc WHERE record_id=?').run(goneId)

    const retainedId = newRecordId()
    const cursors: Array<string | null | undefined> = []
    const { client, imports } = capturingClient({
      listDocs: async (query) => {
        cursors.push(query.cursor)
        if (query.cursor == null)
          return {
            items: Array.from({ length: 100 }, (_, index) => ({
              id: newRecordId(),
              scope: 'machine',
              subject: null,
              owner: null,
              slug: `other-${index}`,
            })),
            nextCursor: 'page-2',
          }
        return {
          items: [
            {
              id: retainedId,
              scope: 'machine',
              subject: null,
              owner: null,
              slug: 'paged-gone',
            },
          ],
          nextCursor: null,
        }
      },
      listRevisions: async (id) => (id === retainedId ? [{ id: revisionId }] : []),
    })
    installRecordApiClient(client)

    await pushDocsCommand({ dryRun: false }, { log: () => undefined })

    expect(cursors).toEqual([null, 'page-2'])
    expect(imports).toHaveLength(1)
    expect(imports[0]?.doc.id).toBe(retainedId)
  })

  test('a featured document and its revision keep the flag in the import', async () => {
    const id = insertDoc({
      scope: 'machine',
      subject: null,
      slug: 'guide',
      title: 'Guide',
      body: 'current',
      delivery: 'demand',
      createdAt: OLD,
      updatedAt: NEW,
    })
    const revision = insertRevision({
      docId: id,
      scope: 'machine',
      subject: null,
      slug: 'guide',
      op: 'create',
      title: 'Guide',
      body: 'current',
      delivery: 'demand',
      reason: 'create guide',
      at: OLD,
    })
    db().query('UPDATE doc SET featured=1 WHERE record_id=?').run(id)
    db().query('UPDATE doc_revision SET featured=1 WHERE record_id=?').run(revision)
    db().query("UPDATE doc SET kind='article' WHERE record_id=?").run(id)
    db().query("UPDATE doc_revision SET kind='article' WHERE record_id=?").run(revision)
    const { client, imports } = capturingClient()
    installRecordApiClient(client)
    await pushDocsCommand({ dryRun: false }, { log: () => undefined })
    expect(imports[0]?.doc.featured).toBe(true)
    expect(imports[0]?.revisions[0]?.featured).toBe(true)
    expect(imports[0]?.doc.kind).toBe('article')
    expect(imports[0]?.revisions[0]?.kind).toBe('article')
  })

  test('draft and superseded documents keep lifecycle fields and import replacements first', async () => {
    const supersededId = insertDoc({
      scope: 'machine',
      subject: null,
      slug: 'a-old',
      title: 'Old',
      body: 'old',
      delivery: 'demand',
      createdAt: OLD,
      updatedAt: NEW,
    })
    const supersededRevision = insertRevision({
      docId: supersededId,
      scope: 'machine',
      subject: null,
      slug: 'a-old',
      op: 'set',
      title: 'Old',
      body: 'old',
      delivery: 'demand',
      reason: 'supersede old',
      at: NEW,
    })
    const replacementId = insertDoc({
      scope: 'machine',
      subject: null,
      slug: 'z-new',
      title: 'New',
      body: 'new',
      delivery: 'demand',
      createdAt: OLD,
      updatedAt: NEW,
    })
    const draftRevision = insertRevision({
      docId: replacementId,
      scope: 'machine',
      subject: null,
      slug: 'z-new',
      op: 'create',
      title: 'New',
      body: 'new',
      delivery: 'demand',
      reason: 'draft new',
      at: NEW,
    })
    db()
      .query("UPDATE doc SET status='superseded', replacement_slug='z-new' WHERE record_id=?")
      .run(supersededId)
    db()
      .query(
        "UPDATE doc_revision SET status='superseded', replacement_slug='z-new' WHERE record_id=?",
      )
      .run(supersededRevision)
    db().query("UPDATE doc SET status='draft' WHERE record_id=?").run(replacementId)
    db().query("UPDATE doc_revision SET status='draft' WHERE record_id=?").run(draftRevision)
    const { client, imports } = capturingClient()
    installRecordApiClient(client)

    await pushDocsCommand({ dryRun: false }, { log: () => undefined })

    expect(imports.map((input) => input.doc.slug)).toEqual(['z-new', 'a-old'])
    expect(imports[0]?.doc.status).toBe('draft')
    expect(imports[0]?.revisions[0]?.status).toBe('draft')
    expect(imports[1]?.doc).toMatchObject({
      status: 'superseded',
      replacementSlug: 'z-new',
    })
    expect(imports[1]?.revisions[0]).toMatchObject({
      status: 'superseded',
      replacementSlug: 'z-new',
    })
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

  test('push explicitly clears a hosted written summary from a local snapshot', async () => {
    const liveId = insertDoc({
      scope: 'machine',
      subject: null,
      slug: 'clear-summary',
      title: 'Clear summary',
      body: 'Derived local summary.',
      delivery: 'inject',
      createdAt: OLD,
      updatedAt: NEW,
    })
    insertRevision({
      docId: liveId,
      scope: 'machine',
      subject: null,
      slug: 'clear-summary',
      op: 'set',
      title: 'Clear summary',
      body: 'Derived local summary.',
      delivery: 'inject',
      reason: 'clear summary locally',
      at: NEW,
    })
    const recordId = liveId
    const { client, imports, hosted } = capturingClient()
    hosted.set(recordId, {
      id: recordId,
      summary: 'Hosted written summary.',
      summarySource: 'written',
    })
    installRecordApiClient(client)

    await pushDocsCommand({ dryRun: false }, { log: () => undefined })

    expect(imports).toHaveLength(1)
    expect(imports[0]?.doc).toHaveProperty('summary', null)
    expect(imports[0]?.revisions[0]).toHaveProperty('summary', null)
    expect(await client.getDoc(recordId)).toMatchObject({
      summary: 'Derived local summary.',
      summarySource: 'derived',
    })
  })
})
