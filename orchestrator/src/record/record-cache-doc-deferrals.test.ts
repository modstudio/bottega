import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record/schema.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { db } from '../database/db.ts'
import { registerLocalProject } from '../project/project-registration.ts'
import { upsertProject } from '../project/projects.ts'
import { pullRecordCache } from './record-cache.ts'
import { writeCursor } from './record-cache-cursor.ts'
import { classifyRecordCacheSubjectDeferrals } from './record-cache-doc-deferrals.ts'
import { encodeRecordCursor } from './record-cursor.ts'

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const activeIdentity = async () => ({
  user: { id: newRecordId() },
  activeSpaceId: 'space-active',
  personalSpaceId: 'space-active',
  memberships: [{ space_id: 'space-active', slug: 'active', permission: 'write' as const }],
})

function ownershipTransitionFixture() {
  const projectRecordId = newRecordId()
  const projectName = 'ownership-transition'
  const subjectId = newRecordId()
  const referencedDocId = newRecordId()
  const validDocId = newRecordId()
  const lensId = newRecordId()
  const workflowId = newRecordId()
  const portId = newRecordId()
  const activeAt = '2026-10-08T12:00:00.000Z'
  let changes = 0
  const doc = (id: string, slug: string, relatedSubjects: Array<{ id: string }> = []) => ({
    id,
    scope: 'project',
    subject: projectName,
    owner: null,
    slug,
    title: slug,
    body: 'Body',
    delivery: 'demand',
    audiences: ['technical'],
    parentId: null,
    position: 0,
    relatedSubjects,
    sourceFiles: [],
    createdAt: activeAt,
    updatedAt: activeAt,
    deletedAt: null,
  })
  const client = createMemoryRecordApiClient()
  client.whoami = async () => ({
    user: { id: newRecordId() },
    activeSpaceId: 'space-active',
    personalSpaceId: 'space-active',
    memberships: [
      { space_id: 'space-active', slug: 'active', permission: 'write' },
      { space_id: 'space-alpha', slug: 'alpha', permission: 'write' },
    ],
  })
  client.listChanges = async () =>
    changes++ === 0
      ? { reset: { cursor: 'ownership-reset', tables: [] } }
      : { changes: [], cursor: 'ownership-reset', lag: 0, more: false }
  client.listProjectSubjects = async (_query, destination) => {
    if (destination?.destinationSpaceId !== 'space-active') return { items: [], nextCursor: null }
    return {
      items: [
        {
          id: subjectId,
          project: projectName,
          name: 'Referenced subject',
          definition: 'Arrives with the referencing document.',
          position: 0,
          parentId: null,
          state: 'active' as const,
          retiredAt: null,
          createdAt: activeAt,
          updatedAt: activeAt,
        },
      ],
      nextCursor: null,
    }
  }
  client.listDocs = async (_query, destination) => {
    return destination?.destinationSpaceId === 'space-active'
      ? {
          items: [
            doc(referencedDocId, 'references-subject', [{ id: subjectId }]),
            doc(validDocId, 'valid-doc'),
          ],
          nextCursor: null,
        }
      : { items: [], nextCursor: null }
  }
  client.listLensCatalogue = async (table, _query, destination) =>
    table === 'lens' && destination?.destinationSpaceId === 'space-active'
      ? {
          items: [
            {
              id: lensId,
              spaceId: 'space-active',
              key: 'after-owned-docs',
              title: 'After owned docs',
              question: 'Did the later family run?',
              excludes: 'Nothing.',
              slots: '{"type":"object","properties":{},"additionalProperties":false}',
              version: 1,
              enabled: true,
              requiresExecution: false,
              updatedAt: activeAt,
            },
          ],
          nextCursor: null,
          endCursor: encodeRecordCursor({ at: activeAt, id: lensId }),
        }
      : { items: [], nextCursor: null }
  client.listWorkflowCatalogue = async (table, _query, destination) => ({
    items:
      table === 'workflow' && destination?.destinationSpaceId === 'space-active'
        ? [
            {
              id: workflowId,
              spaceId: 'space-active',
              slug: 'after-owned-docs',
              generation: 1,
              createdAt: activeAt,
              updatedAt: activeAt,
            },
          ]
        : [],
    nextCursor: null,
  })
  client.listPortCatalogue = async (table, _query, destination) => ({
    items:
      table === 'port_doctrine' && destination?.destinationSpaceId === 'space-active'
        ? [
            {
              id: portId,
              spaceId: 'space-active',
              number: 1,
              title: 'After owned docs',
              body: 'The port family still runs.',
              createdAt: activeAt,
              retiredAt: null,
              version: 1,
              updatedAt: activeAt,
            },
          ]
        : [],
    nextCursor: null,
  })
  installRecordApiClient(client)
  return {
    projectRecordId,
    projectName,
    subjectId,
    referencedDocId,
    validDocId,
    lensId,
    workflowId,
    portId,
    register() {
      registerLocalProject(
        {
          recordId: projectRecordId,
          name: projectName,
          path: '/w/ownership-transition',
          stack: null,
          canon: false,
          retiredAt: null,
          settings: { space: 'active' },
        },
        'space-active',
        db(),
      )
    },
    directWrite() {
      upsertProject({
        recordId: projectRecordId,
        name: projectName,
        path: '/w/ownership-transition',
        settings: { space: 'active' },
      })
    },
  }
}

async function expectUnregisteredProjectDeferral(
  fixture: ReturnType<typeof ownershipTransitionFixture>,
): Promise<void> {
  expect(await pullRecordCache(db())).toMatchObject({
    waitingOnUnregistered: [
      {
        docId: fixture.referencedDocId,
        subjectId: fixture.subjectId,
        project: fixture.projectName,
      },
    ],
  })
  expect(db().query('SELECT 1 FROM subject WHERE id=?').get(fixture.subjectId)).toBeNull()
  expect(db().query('SELECT 1 FROM doc WHERE record_id=?').get(fixture.referencedDocId)).toBeNull()
  expect(db().query('SELECT 1 FROM doc WHERE record_id=?').get(fixture.validDocId)).not.toBeNull()
  expect(db().query('SELECT 1 FROM lens WHERE record_id=?').get(fixture.lensId)).not.toBeNull()
  expect(
    db().query('SELECT 1 FROM workflow WHERE record_id=?').get(fixture.workflowId),
  ).not.toBeNull()
  expect(
    db().query('SELECT 1 FROM port_doctrine WHERE record_id=?').get(fixture.portId),
  ).not.toBeNull()
}

test('an unregistered project defers its referencing doc after later keyset families run', async () => {
  const fixture = ownershipTransitionFixture()

  await expectUnregisteredProjectDeferral(fixture)
  expect(
    db().query("SELECT 1 FROM schema_meta WHERE key='record_subjects_cursor:space-active'").get(),
  ).not.toBeNull()
  expect(
    db().query("SELECT 1 FROM schema_meta WHERE key='record_docs_cursor:space-active'").get(),
  ).toBeNull()
})

test('registration applies subjects and docs after the initial waiting pull', async () => {
  const fixture = ownershipTransitionFixture()
  await expectUnregisteredProjectDeferral(fixture)
  fixture.register()

  expect(await pullRecordCache(db())).toMatchObject({ subjects: 1, docs: 2 })
  expect(db().query('SELECT space_id FROM subject WHERE id=?').get(fixture.subjectId)).toEqual({
    space_id: 'space-active',
  })
  expect(
    db().query('SELECT space_id FROM doc WHERE record_id=?').get(fixture.referencedDocId),
  ).toEqual({ space_id: 'space-active' })
  expect(db().query('SELECT space_id FROM doc WHERE record_id=?').get(fixture.validDocId)).toEqual({
    space_id: 'space-active',
  })
  expect(
    db().query("SELECT 1 FROM schema_meta WHERE key='record_subjects_cursor:space-active'").get(),
  ).not.toBeNull()
  expect(
    db().query("SELECT 1 FROM schema_meta WHERE key='record_docs_cursor:space-active'").get(),
  ).not.toBeNull()
})

test('a project mapped by a non-registration writer applies subjects and docs on the next pull', async () => {
  const fixture = ownershipTransitionFixture()
  await expectUnregisteredProjectDeferral(fixture)
  fixture.directWrite()

  expect(await pullRecordCache(db())).toMatchObject({ subjects: 1, docs: 2 })
  expect(db().query('SELECT 1 FROM subject WHERE id=?').get(fixture.subjectId)).not.toBeNull()
  expect(db().query('SELECT 1 FROM doc WHERE record_id=?').get(fixture.referencedDocId)).not.toBeNull()
})

test('a first pull with no persisted project map does not clear keyset cursors', async () => {
  const fixture = ownershipTransitionFixture()
  fixture.directWrite()
  const existingCursor = JSON.stringify({
    at: '2026-10-01T12:00:00.000Z',
    id: newRecordId(),
  })
  writeCursor(db(), 'record_subjects_cursor:space-active', existingCursor)
  writeCursor(db(), 'record_docs_cursor:space-active', existingCursor)
  db().exec(`CREATE TEMP TRIGGER reject_first_pull_rewind
    BEFORE DELETE ON schema_meta
    WHEN OLD.key IN ('record_subjects_cursor:space-active', 'record_docs_cursor:space-active')
    BEGIN SELECT RAISE(FAIL, 'first pull rewound a cursor'); END`)

  await expect(pullRecordCache(db())).resolves.toMatchObject({ subjects: 1, docs: 2 })
  expect(
    db().query("SELECT value FROM schema_meta WHERE key='record_cache_project_spaces'").get(),
  ).toEqual({ value: JSON.stringify([[fixture.projectName, 'space-active']]) })
})

test('classifies only hosted subjects of absent projects as waiting', () => {
  const waitingSubject = newRecordId()
  const registeredSubject = newRecordId()
  const unknownSubject = newRecordId()
  const classified = classifyRecordCacheSubjectDeferrals(
    new Map([
      ['waiting-doc', new Set([waitingSubject])],
      ['registered-doc', new Set([registeredSubject])],
      ['unknown-doc', new Set([unknownSubject])],
    ]),
    new Map([
      [waitingSubject, 'waiting-project'],
      [registeredSubject, 'registered-project'],
    ]),
    new Map([['registered-project', 'space-active']]),
  )

  expect(classified.waitingOnUnregistered).toEqual([
    { docId: 'waiting-doc', subjectId: waitingSubject, project: 'waiting-project' },
  ])
  expect(classified.refusing).toEqual(
    new Map([
      ['registered-doc', new Set([registeredSubject])],
      ['unknown-doc', new Set([unknownSubject])],
    ]),
  )
})

test('replaces pulled related subjects and refuses subjects that are not local', async () => {
  const projectRecordId = newRecordId()
  const docRecordId = newRecordId()
  const subjectIds = [newRecordId(), newRecordId(), newRecordId()]
  const missingSubjectId = newRecordId()
  upsertProject({
    recordId: projectRecordId,
    name: 'related-subjects',
    path: '/w/related-subjects',
    settings: {},
  })
  const insertSubject = db().query(
    `INSERT INTO subject
     (id,project_record_id,name,definition,position,created_at,updated_at)
     VALUES (?,?,?,?,?,'2026-10-23T12:00:00.000Z','2026-10-23T12:00:00.000Z')`,
  )
  for (const [position, id] of subjectIds.entries()) {
    const name = `Subject ${position}`
    insertSubject.run(id, projectRecordId, name, `${name}.`, position)
  }

  let pull = 0
  const relatedByPull = [subjectIds.slice(0, 2), subjectIds.slice(2), [missingSubjectId]]
  const client = createMemoryRecordApiClient()
  client.whoami = activeIdentity
  client.listDocs = async () => {
    const relatedSubjects = relatedByPull[pull++] ?? []
    return {
      items: [
        {
          id: docRecordId,
          scope: 'global',
          subject: null,
          owner: null,
          slug: 'related-subjects',
          title: 'Related subjects',
          body: 'Body',
          delivery: 'demand',
          audiences: ['technical'],
          parentId: null,
          position: 0,
          relatedSubjects: relatedSubjects.map((id) => ({ id })),
          sourceFiles: [],
          createdAt: '2026-10-23T12:00:00.000Z',
          updatedAt: `2026-10-23T12:00:0${pull}.000Z`,
          deletedAt: null,
        },
      ],
      nextCursor: null,
    }
  }
  installRecordApiClient(client)
  const relatedRows = () =>
    db()
      .query<{ record_id: string; doc_record_id: string; subject_id: string }, [string]>(
        'SELECT record_id,doc_record_id,subject_id FROM doc_related_subject WHERE doc_record_id=? ORDER BY subject_id',
      )
      .all(docRecordId)

  await pullRecordCache(db())
  expect(relatedRows()).toEqual(
    subjectIds.slice(0, 2).map((subjectId) => ({
      record_id: expect.stringMatching(UUID_V7),
      doc_record_id: docRecordId,
      subject_id: subjectId,
    })),
  )
  await pullRecordCache(db())
  expect(relatedRows()).toEqual([
    {
      record_id: expect.stringMatching(UUID_V7),
      doc_record_id: docRecordId,
      subject_id: subjectIds[2]!,
    },
  ])
  await expect(pullRecordCache(db())).rejects.toThrow(`subject ${missingSubjectId} is not local`)
})

test('defers a document with a non-local subject until after later keyset families run', async () => {
  const deferredDocId = newRecordId()
  const validDocId = newRecordId()
  const missingSubjectId = newRecordId()
  const lensId = newRecordId()
  const updatedAt = '2026-10-08T12:00:00.000Z'
  const doc = (id: string, slug: string, relatedSubjects: Array<{ id: string }> = []) => ({
    id,
    scope: 'global',
    subject: null,
    owner: null,
    slug,
    title: slug,
    body: 'Body',
    delivery: 'demand',
    audiences: ['technical'],
    parentId: null,
    position: 0,
    relatedSubjects,
    sourceFiles: [],
    createdAt: updatedAt,
    updatedAt,
    deletedAt: null,
  })
  const client = createMemoryRecordApiClient()
  client.whoami = activeIdentity
  client.listDocs = async () => ({
    items: [
      doc(deferredDocId, 'deferred-subject', [{ id: missingSubjectId }]),
      doc(validDocId, 'valid-after-deferral'),
    ],
    nextCursor: null,
  })
  client.listLensCatalogue = async (table) =>
    table === 'lens'
      ? {
          items: [
            {
              id: lensId,
              spaceId: 'space-active',
              key: 'after-doc-deferral',
              title: 'After doc deferral',
              question: 'Did the later family run?',
              excludes: 'Nothing.',
              slots: '{"type":"object","properties":{},"additionalProperties":false}',
              version: 1,
              enabled: true,
              requiresExecution: false,
              updatedAt,
            },
          ],
          nextCursor: null,
          endCursor: encodeRecordCursor({ at: updatedAt, id: lensId }),
        }
      : { items: [], nextCursor: null }
  let subjectListings = 0
  client.listProjectSubjects = async () => {
    if (subjectListings++) throw new Error('hosted subject listing unavailable')
    return { items: [], nextCursor: null }
  }
  installRecordApiClient(client)

  await expect(pullRecordCache(db())).rejects.toThrow(
    new RegExp(
      `${deferredDocId}[\\s\\S]*${missingSubjectId}[\\s\\S]*hosted subject listing unavailable`,
    ),
  )
  expect(db().query('SELECT 1 FROM doc WHERE record_id=?').get(deferredDocId)).toBeNull()
  expect(db().query('SELECT 1 FROM doc WHERE record_id=?').get(validDocId)).not.toBeNull()
  expect(
    db().query("SELECT 1 FROM schema_meta WHERE key='record_docs_cursor:space-active'").get(),
  ).toBeNull()
  expect(db().query('SELECT 1 FROM lens WHERE record_id=?').get(lensId)).not.toBeNull()
  expect(
    db().query("SELECT value FROM schema_meta WHERE key='record_change_cursor'").get(),
  ).not.toBeNull()
  expect(
    db().query("SELECT value FROM schema_meta WHERE key='record_change_pull_spaces'").get(),
  ).toEqual({ value: '["space-active"]' })
})
