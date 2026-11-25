import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { PGlite } from '@electric-sql/pglite'
import { createNoDestinationWriteCounter } from '../../shared/record-no-destination-write-counter.ts'
import { createHostedRecordFixture, pgliteSql } from '../test/hosted-record-fixture.ts'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { db } from './db.ts'
import { hostedRequestHandler } from './hosted.ts'
import { listHostedNotes } from './hosted-note-list.ts'
import { listHostedNoteCandidates } from './hosted-note-candidates.ts'
import { createHostedNote, getHostedNote } from './hosted-notes.ts'
import { applyHostedPushChanges } from './hosted-push-changes.ts'
import { createNote } from './note.ts'
import { listNotes } from './note-read.ts'
import { projectRecordIdFor } from './project-record-id.ts'

const spaceId = '01990000-0000-7000-8000-000000002528'
const userId = '01990000-0000-7000-8000-000000002529'
const projectId = projectRecordIdFor('gamma')
let database: PGlite
let recordFetch: (input: string, init?: RequestInit) => Promise<Response>

beforeAll(async () => {
  database = await createHostedRecordFixture({ spaceId, userId })
  await database.exec(`
    RESET ROLE;
    UPDATE space SET slug='declared-gamma-space' WHERE id='${spaceId}';
    INSERT INTO project (id,space_id,name,key_prefixes,created_at)
    VALUES ('${projectId}','${spaceId}','gamma',ARRAY['GAM'],now());
    SET ROLE record_actor;
  `)
  const client = pgliteSql(database)
  const identityFetch = async () =>
    Response.json({
      user: { id: userId, name: 'Record author' },
      activeSpaceId: spaceId,
      memberships: [{ space_id: spaceId, slug: 'declared-gamma-space', permission: 'write' }],
    })
  const handler = hostedRequestHandler(
    {
      recordApiUrl: 'https://record.example.test',
      recordDatabaseUrl: client,
      noDestinationWriteCounter: createNoDestinationWriteCounter(),
    },
    {
      tasks: { fetch: identityFetch as unknown as typeof fetch },
      notes: {
        fetch: identityFetch as unknown as typeof fetch,
        create: createHostedNote,
        get: getHostedNote,
        list: listHostedNotes,
        listCandidates: listHostedNoteCandidates,
      },
      changes: { fetch: identityFetch, push: applyHostedPushChanges },
    },
  )
  recordFetch = (input, init) => handler(new Request(input, init))
})

afterAll(async () => {
  if (database) await database.close()
  resetFixtureStore()
})

test('a note filed in one client store lists in another without a pull', async () => {
  resetFixtureStore()
  const hosted = {
    baseUrl: 'https://hub.example.test',
    token: 'test',
    fetch: recordFetch,
  }
  const created = await createNote(
    {
      project: 'gamma',
      text: 'Cross-machine hosted observation',
      forceNew: true,
      anchor: {
        id: crypto.randomUUID(),
        cwd: '/fixtures/repos/gamma',
        project: 'gamma',
        files: [],
        run_record_id: null,
        branch: null,
        commit: null,
        session_id: 'client-a',
      },
    },
    { hosted },
  )

  resetFixtureStore()
  expect(db().query('SELECT 1 FROM note').all()).toHaveLength(0)
  const listed = await listNotes({ project: 'gamma', actionable: true }, hosted)
  expect(listed).toHaveLength(1)
  expect(listed[0]).toMatchObject({
    record_id: created.note.record_id,
    text: 'Cross-machine hosted observation',
  })
  expect(db().query('SELECT 1 FROM note').all()).toHaveLength(0)
})
