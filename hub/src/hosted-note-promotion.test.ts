import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { PGlite } from '@electric-sql/pglite'
import { createHostedRecordFixture, pgliteSql } from '../test/hosted-record-fixture.ts'
import { hostedRouteTestConfig } from '../test/hosted-route-fixture.ts'
import { promoteHostedNote } from './hosted-notes.ts'
import { noteApi } from './note-api.ts'
import {
  HOSTED_PROMOTION_TITLE_REFUSAL,
  PROMOTED_TASK_TITLE_REFUSAL,
} from './note-promotion-body.ts'

const spaceId = '01990000-0000-7000-8000-000000001440'
const userId = '01990000-0000-7000-8000-000000001441'
const projectId = '01990000-0000-7000-8000-000000001442'
const titledNoteId = '01990000-0000-7000-8000-000000001443'
const blankTitleNoteId = '01990000-0000-7000-8000-000000001444'
const missingTitleNoteId = '01990000-0000-7000-8000-000000001445'
const linkingNoteId = '01990000-0000-7000-8000-000000001446'
const existingTaskId = '01990000-0000-7000-8000-000000001447'
const at = '2026-10-25T12:00:00.000Z'
let database: PGlite

beforeAll(async () => {
  database = await createHostedRecordFixture({ spaceId, userId })
  await database.exec(`
    RESET ROLE;
    INSERT INTO project (id,space_id,name,key_prefixes,created_at)
    VALUES ('${projectId}','${spaceId}','hub',ARRAY['DEV'],'${at}');
    INSERT INTO hub_note
      (id,space_id,project_name,project_id,number,project,text,anchors,sightings,created_at,last_seen_at,updated_at)
    VALUES
      ('${titledNoteId}','${spaceId}','hub','${projectId}',1,'hub','Note text','[]',1,'${at}','${at}','${at}'),
      ('${blankTitleNoteId}','${spaceId}','hub','${projectId}',2,'hub','Other note text','[]',1,'${at}','${at}','${at}'),
      ('${missingTitleNoteId}','${spaceId}','hub','${projectId}',3,'hub','Missing title note','[]',1,'${at}','${at}','${at}'),
      ('${linkingNoteId}','${spaceId}','hub','${projectId}',4,'hub','Linking note','[]',1,'${at}','${at}','${at}');
    INSERT INTO hub_task
      (id,space_id,project_name,project_id,key,project,title,source,first_seen,last_seen,created_at,updated_at)
    VALUES
      ('${existingTaskId}','${spaceId}','hub','${projectId}','DEV-90','hub','Existing task','local','${at}','${at}','${at}','${at}');
    SET ROLE record_actor;
  `)
})

afterAll(async () => {
  if (database) await database.close()
})

const identityFetch = (async () =>
  Response.json({
    user: { id: userId },
    activeSpaceId: spaceId,
    memberships: [{ space_id: spaceId, slug: 'active', permission: 'write' }],
  })) as unknown as typeof fetch

async function promoteThroughRoute(noteId: string, body: Record<string, unknown>) {
  return noteApi(
    new Request(`https://hub.example.test/v1/notes/${noteId}/promote`, {
      method: 'POST',
      headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    hostedRouteTestConfig,
    {
      fetch: identityFetch,
      promote: (_url: unknown, _identity: unknown, id: string, input: never) =>
        promoteHostedNote(pgliteSql(database), { userId, spaceId }, id, input),
    },
  )
}

test('a creating promotion without a title is refused and creates no task', async () => {
  const before = await database.query<{ count: number }>('SELECT count(*)::int count FROM hub_task')
  const response = await promoteThroughRoute(missingTitleNoteId, {})
  const after = await database.query<{ count: number }>('SELECT count(*)::int count FROM hub_task')

  expect(response?.status).toBe(400)
  expect(await response?.json()).toEqual({
    error: HOSTED_PROMOTION_TITLE_REFUSAL,
  })
  expect(after.rows[0]?.count).toBe(before.rows[0]?.count)
})

test('a creating promotion with a blank title is refused', async () => {
  const response = await promoteThroughRoute(blankTitleNoteId, { title: '   ' })

  expect(response?.status).toBe(400)
  expect(await response?.json()).toEqual({
    error: expect.stringContaining(PROMOTED_TASK_TITLE_REFUSAL),
  })
})

test('promoteHostedNote refuses a blank creating title', async () => {
  await expect(
    promoteHostedNote(pgliteSql(database), { userId, spaceId }, blankTitleNoteId, {
      title: '   ',
    }),
  ).rejects.toThrow(PROMOTED_TASK_TITLE_REFUSAL)
})

test('promoteHostedNote creates a task with the supplied title', async () => {
  const promoted = await promoteHostedNote(pgliteSql(database), { userId, spaceId }, titledNoteId, {
    title: 'State the promoted task point',
  })

  expect(promoted?.task?.title).toBe('State the promoted task point')
})

test('promoteHostedNote links an existing task without a title', async () => {
  const promoted = await promoteHostedNote(
    pgliteSql(database),
    { userId, spaceId },
    linkingNoteId,
    { task: 'DEV-90' },
  )

  expect(promoted?.note.promoted_task).toBe('DEV-90')
  expect(promoted?.task?.id).toBe(existingTaskId)
})
