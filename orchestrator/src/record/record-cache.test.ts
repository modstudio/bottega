import { describe, expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record/schema.ts'
import { installRecordApiClient, unusedBoardClientMethods } from '../../test/fixtures/record-api.ts'
import { db } from '../database/db.ts'
import { retireProject, upsertProject } from '../project/projects.ts'
import { subjectClient } from '../subject/subject-client.ts'
import type { RecordApiClient } from './record-api-client.ts'
import { pullRecordCache } from './record-cache.ts'
import { decodeRecordCursor, encodeRecordCursor } from './record-cursor.ts'

function clientWith(overrides: Partial<RecordApiClient> = {}): RecordApiClient {
  return {
    ...unusedBoardClientMethods(),
    whoami: async () => ({
      user: { id: newRecordId() },
      activeSpaceId: 'space-active',
      personalSpaceId: 'space-active',
      memberships: [{ space_id: 'space-active', slug: 'active' }],
    }),
    inviteMember: async () => ({ id: newRecordId() }),
    putSnapshot: async () => ({ takenAt: new Date().toISOString() }),
    listSnapshots: async () => ({ items: [] }),
    listDocs: async () => ({ items: [], nextCursor: null }),
    getDoc: async () => ({}),
    listRevisions: async () => [],
    upsertDoc: async () => ({ id: newRecordId(), revisionId: newRecordId() }),
    applySettingsPermission: async () => ({
      revision: newRecordId(),
      permissions: { allow: [], ask: [], deny: [] },
    }),
    importDoc: async () => ({ id: newRecordId(), revisionIds: [] }),
    importCanon: async () => ({ rows: [], deletions: [], findings: [], bootstrap: false }),
    deleteDoc: async () => ({ id: newRecordId(), revisionId: newRecordId() }),
    consumeDoc: async () => ({
      id: newRecordId(),
      revisionId: newRecordId(),
      alreadyConsumed: false,
    }),
    restoreDoc: async () => ({ id: newRecordId(), revisionId: newRecordId() }),
    renameSubject: async () => ({ docs: 0, revisions: 0 }),
    upsertProject: async () => ({ name: 'unused' }),
    listProjects: async () => [],
    retireProject: async () => ({ name: 'unused' }),
    listProjectSubjects: async () => ({ items: [], nextCursor: null }),
    addProjectSubject: async () => {
      throw new Error('hosted subjects are unused in this fixture')
    },
    renameProjectSubject: async () => {
      throw new Error('hosted subjects are unused in this fixture')
    },
    defineProjectSubject: async () => {
      throw new Error('hosted subjects are unused in this fixture')
    },
    reorderProjectSubjects: async () => {
      throw new Error('hosted subjects are unused in this fixture')
    },
    retireProjectSubject: async () => {
      throw new Error('hosted subjects are unused in this fixture')
    },
    putScore: async () => undefined,
    voidRun: async () => undefined,
    unvoidRun: async () => undefined,
    listScores: async () => ({ items: [], nextCursor: null }),
    counts: async () => ({ docs: 0, revisions: 0, scores: 0, voids: 0 }),
    ...overrides,
  }
}

describe('record cache pull', () => {
  test('routes a subject write to the project destination instead of the active space', async () => {
    upsertProject({ name: 'alpha', path: '/w/alpha', settings: { space: 'alpha' } })
    let destination: string | undefined
    const subject = {
      id: newRecordId(),
      project: 'alpha',
      name: 'One',
      definition: 'One.',
      position: 0,
      parentId: null,
      state: 'active' as const,
      retiredAt: null,
      createdAt: '2026-10-08T12:00:00.000Z',
      updatedAt: '2026-10-08T12:00:00.000Z',
    }
    installRecordApiClient(
      clientWith({
        whoami: async () => ({
          user: { id: newRecordId() },
          activeSpaceId: 'space-active',
          personalSpaceId: 'space-active',
          memberships: [
            { space_id: 'space-active', slug: 'active' },
            { space_id: 'space-alpha', slug: 'alpha' },
          ],
        }),
        addProjectSubject: async (_input, target) => {
          destination = target?.destinationSpaceId
          return subject
        },
      }),
    )
    await subjectClient.add({
      id: subject.id,
      project: subject.project,
      name: subject.name,
      definition: subject.definition,
    })
    expect(destination).toBe('space-alpha')
  })

  test('refuses a pull when the record session has no active space', async () => {
    let queried = false
    installRecordApiClient(
      clientWith({
        whoami: async () => ({
          user: { id: newRecordId() },
          activeSpaceId: null,
          personalSpaceId: null,
          memberships: [],
        }),
        listDocs: async () => {
          queried = true
          return { items: [], nextCursor: null }
        },
        listScores: async () => {
          queried = true
          return { items: [], nextCursor: null }
        },
      }),
    )

    await expect(pullRecordCache(db())).rejects.toThrow(
      'record session has no active space; run `orch record space switch <slug>`',
    )
    expect(queried).toBe(false)
  })

  test('pulls each distinct live or retired project destination only when it is a membership', async () => {
    upsertProject({ name: 'alpha-one', path: '/w/alpha-one', settings: { space: 'alpha' } })
    upsertProject({ name: 'alpha-two', path: '/w/alpha-two', settings: { space: 'alpha' } })
    upsertProject({ name: 'beta-retired', path: '/w/beta', settings: { space: 'beta' } })
    retireProject('beta-retired')
    upsertProject({ name: 'outside', path: '/w/outside', settings: { space: 'outside' } })
    const pulled: string[] = []
    installRecordApiClient(
      clientWith({
        whoami: async () => ({
          user: { id: newRecordId() },
          activeSpaceId: 'space-active',
          personalSpaceId: 'space-active',
          memberships: [
            { space_id: 'space-active', slug: 'active' },
            { space_id: 'space-alpha', slug: 'alpha' },
            { space_id: 'space-beta', slug: 'beta' },
          ],
        }),
        listDocs: async (_query, destination) => {
          pulled.push(destination?.destinationSpaceId ?? 'missing')
          return { items: [], nextCursor: null }
        },
      }),
    )

    await pullRecordCache(db())

    expect(pulled).toEqual(['space-active', 'space-alpha', 'space-beta'])
  })

  test('applies live rows and deletions only from the space owning the address', async () => {
    upsertProject({ name: 'alpha', path: '/w/alpha', settings: { space: 'alpha' } })
    upsertProject({ name: 'outside', path: '/w/outside', settings: { space: 'outside' } })
    const globalId = newRecordId()
    const item = (overrides: Record<string, unknown>) => ({
      id: newRecordId(),
      scope: 'global',
      subject: null,
      owner: null,
      slug: 'shared',
      title: 'Shared',
      body: 'active copy',
      delivery: 'demand',
      audience: 'technical',
      parentId: null,
      position: 0,
      updatedAt: '2026-10-08T12:00:00.000Z',
      deletedAt: null,
      ...overrides,
    })
    installRecordApiClient(
      clientWith({
        whoami: async () => ({
          user: { id: newRecordId() },
          activeSpaceId: 'space-active',
          personalSpaceId: 'space-active',
          memberships: [
            { space_id: 'space-active', slug: 'active' },
            { space_id: 'space-alpha', slug: 'alpha' },
          ],
        }),
        listDocs: async (_query, destination) => ({
          items:
            destination?.destinationSpaceId === 'space-alpha'
              ? [
                  item({ body: 'wrong-space copy', updatedAt: '2026-10-08T12:01:00.000Z' }),
                  item({
                    id: globalId,
                    deletedAt: '2026-10-08T12:02:00.000Z',
                    updatedAt: '2026-10-08T12:02:00.000Z',
                  }),
                  item({
                    scope: 'project',
                    subject: 'alpha',
                    slug: 'owned',
                    body: 'project copy',
                    updatedAt: '2026-10-08T12:03:00.000Z',
                  }),
                ]
              : [
                  item({ id: globalId }),
                  item({ scope: 'project', subject: 'alpha', slug: 'owned' }),
                  item({ scope: 'project', subject: 'outside', slug: 'unreachable' }),
                ],
          nextCursor: null,
        }),
      }),
    )

    expect(await pullRecordCache(db())).toMatchObject({ docs: 2, skippedDocs: 4 })
    expect(
      db()
        .query<{ body: string }, []>("SELECT body FROM doc WHERE scope='global' AND slug='shared'")
        .get()?.body,
    ).toBe('active copy')
    expect(
      db()
        .query<{ body: string }, []>("SELECT body FROM doc WHERE scope='project' AND slug='owned'")
        .get()?.body,
    ).toBe('project copy')
    expect(db().query("SELECT 1 FROM doc WHERE slug='unreachable'").get()).toBeNull()
  })

  test('does not apply a subject pulled from a space that does not own its project', async () => {
    upsertProject({ name: 'alpha', path: '/w/alpha', settings: { space: 'alpha' } })
    const updatedAt = '2026-10-08T12:00:00.000Z'
    installRecordApiClient(
      clientWith({
        whoami: async () => ({
          user: { id: newRecordId() },
          activeSpaceId: 'space-active',
          personalSpaceId: 'space-active',
          memberships: [
            { space_id: 'space-active', slug: 'active' },
            { space_id: 'space-alpha', slug: 'alpha' },
          ],
        }),
        listProjectSubjects: async (_query, destination) => ({
          items:
            destination?.destinationSpaceId === 'space-active'
              ? [
                  {
                    id: newRecordId(),
                    project: 'alpha',
                    name: 'Wrong space',
                    definition: 'Must not be cached.',
                    position: 0,
                    parentId: null,
                    state: 'active' as const,
                    retiredAt: null,
                    createdAt: updatedAt,
                    updatedAt,
                  },
                ]
              : [],
          nextCursor: null,
        }),
      }),
    )
    expect(await pullRecordCache(db())).toMatchObject({ subjects: 0, skippedSubjects: 1 })
    expect(db().query('SELECT 1 FROM subject').get()).toBeNull()
    const cursor = db()
      .query<{ value: string }, []>(
        "SELECT value FROM schema_meta WHERE key='record_subjects_cursor:space-active'",
      )
      .get()?.value
    expect(cursor && JSON.parse(cursor)).toEqual({
      at: updatedAt,
      id: expect.any(String),
    })
  })

  test('pulls equal-timestamp subjects across a page boundary and resumes after both', async () => {
    upsertProject({ name: 'alpha', path: '/w/alpha', settings: { space: 'alpha' } })
    const updatedAt = '2026-10-08T12:00:00.000Z'
    const firstId = newRecordId()
    const secondId = newRecordId()
    const subject = (id: string, name: string, position: number) => ({
      id,
      project: 'alpha',
      name,
      definition: `${name}.`,
      position,
      parentId: null,
      state: 'active' as const,
      retiredAt: null,
      createdAt: updatedAt,
      updatedAt,
    })
    const seen: Array<{ order?: string; cursor?: { at: string; id: string } }> = []
    installRecordApiClient(
      clientWith({
        whoami: async () => ({
          user: { id: newRecordId() },
          activeSpaceId: 'space-active',
          personalSpaceId: 'space-active',
          memberships: [
            { space_id: 'space-active', slug: 'active' },
            { space_id: 'space-alpha', slug: 'alpha' },
          ],
        }),
        listProjectSubjects: async (query, destination) => {
          if (destination?.destinationSpaceId !== 'space-alpha') {
            return { items: [], nextCursor: null }
          }
          const cursor = query.cursor ? decodeRecordCursor(query.cursor) : undefined
          seen.push({ order: query.order, cursor })
          if (!cursor)
            return {
              items: [subject(firstId, 'First', 0)],
              nextCursor: encodeRecordCursor({ at: updatedAt, id: firstId }),
            }
          if (cursor.id === firstId) {
            return { items: [subject(secondId, 'Second', 1)], nextCursor: null }
          }
          return { items: [], nextCursor: null }
        },
      }),
    )

    expect(await pullRecordCache(db())).toMatchObject({ subjects: 2 })
    expect(await pullRecordCache(db())).toMatchObject({ subjects: 0 })
    expect(
      db().query<{ id: string }, []>('SELECT id FROM subject ORDER BY position').all(),
    ).toEqual([{ id: firstId }, { id: secondId }])
    expect(seen).toEqual([
      { order: 'updated', cursor: undefined },
      { order: 'updated', cursor: { at: updatedAt, id: firstId } },
      { order: 'updated', cursor: { at: updatedAt, id: secondId } },
    ])
    expect(
      JSON.parse(
        db()
          .query<{ value: string }, []>(
            "SELECT value FROM schema_meta WHERE key='record_subjects_cursor:space-alpha'",
          )
          .get()!.value,
      ),
    ).toEqual({ at: updatedAt, id: secondId })
  })

  test('keeps a cursor per space when the active space changes', async () => {
    upsertProject({ name: 'alpha', path: '/w/alpha', settings: { space: 'alpha' } })
    let activeSpaceId = 'space-a'
    const seen: Array<[string, string | undefined]> = []
    installRecordApiClient(
      clientWith({
        whoami: async () => ({
          user: { id: newRecordId() },
          activeSpaceId,
          personalSpaceId: activeSpaceId,
          memberships: [
            { space_id: 'space-a', slug: 'a' },
            { space_id: 'space-b', slug: 'b' },
            { space_id: 'space-alpha', slug: 'alpha' },
          ],
        }),
        listDocs: async (query, destination) => {
          const space = destination?.destinationSpaceId ?? 'missing'
          seen.push([space, query.updatedSince])
          return query.updatedSince
            ? { items: [], nextCursor: null }
            : {
                items: [
                  {
                    id: newRecordId(),
                    scope: 'global',
                    subject: null,
                    slug: `cursor-${space}`,
                    title: 'Cursor',
                    body: 'cursor',
                    delivery: 'demand',
                    updatedAt: `${space}-cursor`,
                  },
                ],
                nextCursor: null,
              }
        },
      }),
    )

    await pullRecordCache(db())
    activeSpaceId = 'space-b'
    await pullRecordCache(db())

    expect(seen).toEqual([
      ['space-a', undefined],
      ['space-alpha', undefined],
      ['space-b', undefined],
      ['space-alpha', 'space-alpha-cursor'],
    ])
    expect(
      db()
        .query<{ value: string }, []>(
          "SELECT value FROM schema_meta WHERE key='record_docs_cursor:space-a'",
        )
        .get()?.value,
    ).toBe('space-a-cursor')
  })

  test('inherits the legacy cursor into the active space only once', async () => {
    db().query("INSERT INTO schema_meta(key,value) VALUES ('record_docs_cursor','legacy')").run()
    let activeSpaceId = 'space-a'
    const seen: Array<string | undefined> = []
    installRecordApiClient(
      clientWith({
        whoami: async () => ({
          user: { id: newRecordId() },
          activeSpaceId,
          personalSpaceId: activeSpaceId,
          memberships: [],
        }),
        listDocs: async (query) => {
          seen.push(query.updatedSince)
          return { items: [], nextCursor: null }
        },
      }),
    )

    await pullRecordCache(db())
    activeSpaceId = 'space-b'
    await pullRecordCache(db())

    expect(seen).toEqual(['legacy', undefined])
    expect(
      db()
        .query<{ value: string }, []>(
          "SELECT value FROM schema_meta WHERE key='record_docs_cursor:space-a'",
        )
        .get()?.value,
    ).toBe('legacy')
    expect(db().query("SELECT 1 FROM schema_meta WHERE key='record_docs_cursor'").get()).toBeNull()
  })

  test('resolves a child whose parent arrives on a later page', async () => {
    const childId = newRecordId()
    const parentId = newRecordId()
    let page = 0
    installRecordApiClient(
      clientWith({
        listDocs: async () => {
          page++
          return page === 1
            ? {
                items: [
                  {
                    id: childId,
                    scope: 'global',
                    subject: null,
                    owner: null,
                    slug: 'child',
                    title: 'Child',
                    body: 'child',
                    delivery: 'demand',
                    audience: 'technical',
                    parentId,
                    position: 1,
                    updatedAt: '2026-09-16T00:00:01.000Z',
                  },
                ],
                nextCursor: 'more',
              }
            : {
                items: [
                  {
                    id: parentId,
                    scope: 'global',
                    subject: null,
                    owner: null,
                    slug: 'parent',
                    title: 'Parent',
                    body: 'parent',
                    delivery: 'demand',
                    audience: 'technical',
                    parentId: null,
                    position: 0,
                    updatedAt: '2026-09-16T00:00:02.000Z',
                  },
                ],
                nextCursor: null,
              }
        },
      }),
    )

    expect(await pullRecordCache(db())).toMatchObject({ docs: 2 })
    expect(
      db()
        .query<{ parent_slug: string | null }, [string]>(
          'SELECT parent.slug AS parent_slug FROM doc child LEFT JOIN doc parent ON parent.id=child.parent_id WHERE child.record_id=?',
        )
        .get(childId)?.parent_slug,
    ).toBe('parent')
  })

  test('reports an unresolved parent and does not advance the cursor', async () => {
    const childId = newRecordId()
    const parentId = newRecordId()
    installRecordApiClient(
      clientWith({
        listDocs: async () => ({
          items: [
            {
              id: childId,
              scope: 'global',
              subject: null,
              owner: null,
              slug: 'orphan',
              title: 'Orphan',
              body: 'orphan',
              delivery: 'demand',
              audience: 'technical',
              parentId,
              position: 0,
              updatedAt: '2026-09-16T00:00:03.000Z',
            },
          ],
          nextCursor: null,
        }),
      }),
    )

    await expect(pullRecordCache(db())).rejects.toThrow(`${childId} -> ${parentId}`)
    expect(
      db().query("SELECT value FROM schema_meta WHERE key='record_docs_cursor:space-active'").get(),
    ).toBeNull()
  })

  test('carries hosted lifecycle and kind through inserts and updates', async () => {
    const insertedDraftId = newRecordId()
    const updatedDraftId = newRecordId()
    const articleId = newRecordId()
    const supersededId = newRecordId()
    const adoptedId = newRecordId()
    db()
      .query(
        `INSERT INTO doc
          (scope, subject, slug, title, body, delivery, audiences, created_at, updated_at, record_id)
         VALUES ('global',NULL,'adopted','Local','local','demand','["technical"]',?,?,?)`,
      )
      .run('2026-09-16T00:00:00.000Z', '2026-09-16T00:00:00.000Z', newRecordId())
    const item = (id: string, slug: string, overrides: Record<string, unknown> = {}) => ({
      id,
      scope: 'global',
      subject: null,
      owner: null,
      slug,
      title: slug,
      body: slug,
      delivery: 'demand',
      audience: 'technical',
      parentId: null,
      position: 0,
      featured: false,
      createdAt: '2026-09-16T00:00:00.000Z',
      updatedAt: '2026-09-16T00:00:01.000Z',
      deletedAt: null,
      ...overrides,
    })
    let pull = 0
    installRecordApiClient(
      clientWith({
        listDocs: async () => {
          pull++
          return {
            items:
              pull === 1
                ? [
                    item(insertedDraftId, 'inserted-draft', { status: 'draft' }),
                    item(updatedDraftId, 'updated-draft'),
                    item(articleId, 'article', { kind: 'article' }),
                    item(supersededId, 'old', {
                      status: 'superseded',
                      replacementSlug: 'new',
                    }),
                    item(adoptedId, 'adopted', { status: 'draft', kind: 'article' }),
                  ]
                : [
                    item(updatedDraftId, 'updated-draft', {
                      status: 'draft',
                      updatedAt: '2026-09-16T00:00:02.000Z',
                    }),
                  ],
            nextCursor: null,
          }
        },
      }),
    )

    await pullRecordCache(db())
    const lifecycle = (id: string) =>
      db()
        .query<{ status: string; kind: string; replacement_slug: string | null }, [string]>(
          'SELECT status,kind,replacement_slug FROM doc WHERE record_id=?',
        )
        .get(id)
    expect(lifecycle(insertedDraftId)).toEqual({
      status: 'draft',
      kind: 'working',
      replacement_slug: null,
    })
    expect(lifecycle(articleId)?.kind).toBe('article')
    expect(lifecycle(supersededId)).toEqual({
      status: 'superseded',
      kind: 'working',
      replacement_slug: 'new',
    })
    expect(lifecycle(updatedDraftId)).toEqual({
      status: 'current',
      kind: 'working',
      replacement_slug: null,
    })
    expect(lifecycle(adoptedId)).toEqual({
      status: 'draft',
      kind: 'article',
      replacement_slug: null,
    })
    expect(
      db()
        .query<{ audiences: string }, [string]>('SELECT audiences FROM doc WHERE record_id=?')
        .get(insertedDraftId),
    ).toEqual({ audiences: '["technical"]' })

    await pullRecordCache(db())
    expect(lifecycle(updatedDraftId)?.status).toBe('draft')
  })

  test('applies an update and a soft delete', async () => {
    const docId = newRecordId()
    const client = clientWith({
      listDocs: async () => ({
        items: [
          {
            id: docId,
            scope: 'machine',
            subject: null,
            slug: 'pulled',
            title: 'Pulled',
            body: 'from-host',
            delivery: 'inject',
            audience: 'technical',
            parentId: null,
            position: 0,
            createdAt: '2026-09-16T00:00:00.000Z',
            updatedAt: '2026-09-16T00:00:01.000Z',
            deletedAt: null,
          },
          {
            id: docId,
            scope: 'machine',
            subject: null,
            slug: 'pulled',
            title: 'Pulled',
            body: 'from-host',
            delivery: 'inject',
            audience: 'technical',
            parentId: null,
            position: 0,
            createdAt: '2026-09-16T00:00:00.000Z',
            updatedAt: '2026-09-16T00:00:02.000Z',
            deletedAt: '2026-09-16T00:00:02.000Z',
          },
        ],
        nextCursor: null,
      }),
    })
    installRecordApiClient(client)
    const first = await pullRecordCache(db())
    expect(first.docs).toBe(2)
    expect(db().query('SELECT 1 FROM doc WHERE record_id=?').get(docId)).toBeNull()
  })

  test.each([
    { name: 'scored void', localId: 8911, scored: true },
    { name: 'unscored void', localId: 8912, scored: false },
  ])('clears a cached $name when unvoid follows the pull cursor', async ({ localId, scored }) => {
    const recordId = newRecordId()
    const scoreAt = '2026-09-24T12:00:00.000Z'
    const voidAt = '2026-09-24T12:01:00.000Z'
    const unvoidAt = '2026-09-24T12:02:00.000Z'
    db()
      .query(
        `INSERT INTO run
          (id,record_id,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,evidence_excluded)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        localId,
        recordId,
        scoreAt,
        'codex',
        'file-question',
        'sha',
        3,
        'ask',
        'ok',
        'voided with orch score --void',
      )
    if (scored) {
      db()
        .query(
          `INSERT INTO score
            (run_id,delivery,quality,fidelity,note,scored_at,scored_by)
           VALUES (?,'full','right',NULL,'kept',?,'architect')`,
        )
        .run(localId, scoreAt)
    }
    db()
      .query(
        `INSERT INTO schema_meta (key,value) VALUES ('record_scores_cursor',?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      )
      .run(voidAt)
    installRecordApiClient(
      clientWith({
        listScores: async (query) => {
          expect(query.updatedSince).toBe(voidAt)
          return {
            items: [
              {
                runId: recordId,
                delivery: scored ? 'full' : null,
                quality: scored ? 'right' : null,
                fidelity: null,
                note: scored ? 'kept' : null,
                scoredAt: scored ? scoreAt : null,
                scoredBy: scored ? 'architect' : null,
                evidenceExcluded: null,
                updatedAt: unvoidAt,
              },
            ],
            nextCursor: null,
          }
        },
      }),
    )

    expect(await pullRecordCache(db())).toMatchObject({ scores: 1 })
    expect(
      db()
        .query<{ evidence_excluded: string | null }, [number]>(
          'SELECT evidence_excluded FROM run WHERE id=?',
        )
        .get(localId)?.evidence_excluded,
    ).toBeNull()
    expect(db().query('SELECT 1 FROM score WHERE run_id=?').get(localId) !== null).toBe(scored)
  })
})
