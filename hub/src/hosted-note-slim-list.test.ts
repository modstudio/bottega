import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { PGlite } from '@electric-sql/pglite'
import { PLATFORM_NAME } from '../../shared/brand.ts'
import { createHostedRecordFixture, pgliteSql } from '../test/hosted-record-fixture.ts'
import { listHostedSlimNotes } from './hosted-note-slim-list.ts'

const spaceId = '01990000-0000-7000-8000-000000002600'
const userId = '01990000-0000-7000-8000-000000002601'
const otherUserId = '01990000-0000-7000-8000-000000002602'
const projectId = '01990000-0000-7000-8000-000000002603'
const id = (value: number) => `01990000-0000-7000-8000-${String(value).padStart(12, '0')}`
let database: PGlite

beforeAll(async () => {
  database = await createHostedRecordFixture({ spaceId, userId })
  await database.exec(`
    RESET ROLE;
    INSERT INTO "user" (id,email,name,created_at)
    VALUES ('${otherUserId}','other@example.test','Other user',now());
    INSERT INTO project(id,space_id,name,created_at)
    VALUES ('${projectId}','${spaceId}','${PLATFORM_NAME}','2026-11-20T09:00:00Z');
    INSERT INTO hub_note
      (id,space_id,project_name,project_id,number,project,text,anchors,sightings,created_at,last_seen_at,updated_at,deleted_at)
    VALUES
      ('${id(2604)}','${spaceId}','${PLATFORM_NAME}','${projectId}',1,'${PLATFORM_NAME}','Literal % Match','[{"session_id":"session-a"}]',2,'2026-11-20T09:00:00Z','2026-11-20T14:00:00Z','2026-11-20T14:00:00Z',NULL),
      ('${id(2605)}','${spaceId}','${PLATFORM_NAME}','${projectId}',2,'${PLATFORM_NAME}','Second match','[{"session_id":"session-a"}]',2,'2026-11-20T09:00:00Z','2026-11-20T13:00:00Z','2026-11-20T13:00:00Z',NULL),
      ('${id(2606)}','${spaceId}','${PLATFORM_NAME}','${projectId}',3,'${PLATFORM_NAME}','Other session','[{"session_id":"session-b"}]',1,'2026-11-20T09:00:00Z','2026-11-20T12:00:00Z','2026-11-20T12:00:00Z',NULL),
      ('${id(2607)}','${spaceId}','${PLATFORM_NAME}','${projectId}',4,'${PLATFORM_NAME}','Deleted','[]',1,'2026-11-20T09:00:00Z','2026-11-20T16:00:00Z','2026-11-20T16:00:00Z','2026-11-20T16:01:00Z');
    INSERT INTO hub_note_acknowledgement
      (id,space_id,project_name,project_id,note_id,session_id,acknowledged_at,sightings,created_at,updated_at)
    VALUES
      ('${id(2608)}','${spaceId}','${PLATFORM_NAME}','${projectId}','${id(2604)}','session-a','2026-11-20T14:01:00Z',2,'2026-11-20T14:01:00Z','2026-11-20T14:01:00Z'),
      ('${id(2609)}','${spaceId}','${PLATFORM_NAME}','${projectId}','${id(2605)}','session-a','2026-11-20T13:01:00Z',1,'2026-11-20T13:01:00Z','2026-11-20T13:01:00Z');
    ALTER TABLE hub_note DISABLE TRIGGER hub_note_hidden_update_guard;
    INSERT INTO hub_note
      (id,space_id,project_name,project_id,number,project,text,anchors,sightings,created_at,last_seen_at,updated_at,author_user_id,hidden_at,hidden_by_user_id,hidden_reason)
    VALUES ('${id(2610)}','${spaceId}','${PLATFORM_NAME}','${projectId}',5,'${PLATFORM_NAME}','Hidden','[]',1,'2026-11-20T09:00:00Z','2026-11-20T15:00:00Z','2026-11-20T15:00:00Z','${otherUserId}','2026-11-20T15:01:00Z','${otherUserId}','spam');
    ALTER TABLE hub_note ENABLE TRIGGER hub_note_hidden_update_guard;
    SET ROLE record_actor;
  `)
})

afterAll(async () => {
  if (database) await database.close()
})

test('slim note list filters, orders, counts, and omits full-row fields', async () => {
  const sql = pgliteSql(database)
  const first = await listHostedSlimNotes(sql, { userId, spaceId }, { limit: 2 })
  expect(first.notes.map((note) => note.record_id)).toEqual([id(2604), id(2605)])
  expect(first.total).toBe(3)
  expect(first.notes[0]).not.toHaveProperty('anchors')

  const text = await listHostedSlimNotes(sql, { userId, spaceId }, { text: '% mAtCh' })
  expect(text.notes.map((note) => note.record_id)).toEqual([id(2604)])

  const kept = await listHostedSlimNotes(
    sql,
    { userId, spaceId },
    { sessions: ['session-a'], kept: true },
  )
  expect(kept.notes.map((note) => note.record_id)).toEqual([id(2604)])

  const notKept = await listHostedSlimNotes(
    sql,
    { userId, spaceId },
    { sessions: ['session-a'], kept: false },
  )
  expect(notKept.notes.map((note) => note.record_id)).toEqual([id(2605)])
})
