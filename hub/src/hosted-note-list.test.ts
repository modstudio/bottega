import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { PGlite } from '@electric-sql/pglite'
import { createHostedRecordFixture, pgliteSql } from '../test/hosted-record-fixture.ts'
import { listHostedNotes } from './hosted-notes.ts'

const spaceId = '01990000-0000-7000-8000-000000001610'
const userId = '01990000-0000-7000-8000-000000001611'
const projectId = '01990000-0000-7000-8000-000000001612'
const at = '2026-10-19T12:00:00.654321Z'
let database: PGlite
const id = (value: number) => `01990000-0000-7000-8000-${String(value).padStart(12, '0')}`

beforeAll(async () => {
  database = await createHostedRecordFixture({ spaceId, userId })
  await database.exec(`
    RESET ROLE;
    INSERT INTO project(id,space_id,name,created_at)
    VALUES ('${projectId}','${spaceId}','bottega','${at}');
    INSERT INTO hub_note
      (id,space_id,project_name,project_id,number,project,text,anchors,sightings,created_at,last_seen_at,updated_at)
    VALUES
      ('${id(1613)}','${spaceId}','bottega','${projectId}',1,'bottega','One','[]',1,'${at}','${at}','${at}'),
      ('${id(1614)}','${spaceId}','bottega','${projectId}',2,'bottega','Two','[]',1,'${at}','${at}','${at}'),
      ('${id(1615)}','${spaceId}','bottega','${projectId}',3,'bottega','Three','[]',1,'${at}','${at}','${at}');
    INSERT INTO hub_note_acknowledgement
      (id,space_id,project_name,project_id,note_id,session_id,acknowledged_at,sightings,created_at,updated_at)
    VALUES ('${id(1616)}','${spaceId}','bottega','${projectId}','${id(1613)}','session','${at}',1,'${at}','${at}');
    INSERT INTO seq(space_id,project_id,name,next)
    VALUES ('${spaceId}','${projectId}','note',4);
    SET ROLE record_actor;
  `)
})

afterAll(async () => {
  if (database) await database.close()
})

test('a first note pull bounds notes, acknowledgements, and counters in ordered pages', async () => {
  const pages = []
  let cursor: string | undefined
  do {
    const page = await listHostedNotes(
      pgliteSql(database),
      { userId, spaceId },
      {
        includeDeleted: true,
        limit: 2,
        cursor,
      },
    )
    pages.push(page)
    cursor = page.cursor
  } while (pages.at(-1)!.more)

  expect(
    pages.every(
      (page) => page.notes.length + page.acknowledgements.length + page.projectCounters.length <= 2,
    ),
  ).toBe(true)
  expect(pages.flatMap((page) => page.notes).map((note) => note.id)).toEqual([
    id(1613),
    id(1614),
    id(1615),
  ])
  expect(pages.flatMap((page) => page.acknowledgements)).toHaveLength(1)
  expect(pages.flatMap((page) => page.projectCounters)).toEqual([{ project: 'bottega', next: 4 }])
})
