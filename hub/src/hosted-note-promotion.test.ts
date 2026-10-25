import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { PGlite } from '@electric-sql/pglite'
import { createHostedRecordFixture, pgliteSql } from '../test/hosted-record-fixture.ts'
import { promoteHostedNote } from './hosted-notes.ts'
import { PROMOTED_TASK_TITLE_REFUSAL } from './note-promotion-body.ts'

const spaceId = '01990000-0000-7000-8000-000000001440'
const userId = '01990000-0000-7000-8000-000000001441'
const projectId = '01990000-0000-7000-8000-000000001442'
const titledNoteId = '01990000-0000-7000-8000-000000001443'
const blankTitleNoteId = '01990000-0000-7000-8000-000000001444'
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
      ('${blankTitleNoteId}','${spaceId}','hub','${projectId}',2,'hub','Other note text','[]',1,'${at}','${at}','${at}');
    SET ROLE record_actor;
  `)
})

afterAll(async () => {
  if (database) await database.close()
})

test('promoteHostedNote creates a task with the supplied title', async () => {
  const promoted = await promoteHostedNote(pgliteSql(database), { userId, spaceId }, titledNoteId, {
    title: 'State the promoted task point',
  })

  expect(promoted?.task?.title).toBe('State the promoted task point')
})

test('promoteHostedNote refuses a title blank after trimming', async () => {
  await expect(
    promoteHostedNote(pgliteSql(database), { userId, spaceId }, blankTitleNoteId, { title: '   ' }),
  ).rejects.toThrow(PROMOTED_TASK_TITLE_REFUSAL)
})
