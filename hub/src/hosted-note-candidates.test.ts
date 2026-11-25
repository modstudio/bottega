import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { PGlite } from '@electric-sql/pglite'
import { createHostedRecordFixture, pgliteSql } from '../test/hosted-record-fixture.ts'
import { listHostedNoteCandidates } from './hosted-note-candidates.ts'
import { NOTE_DUPLICATE_CANDIDATES } from './note-duplicate-candidates.ts'

const spaceId = '01990000-0000-7000-8000-000000002000'
const otherSpaceId = '01990000-0000-7000-8000-000000002001'
const userId = '01990000-0000-7000-8000-000000002002'
const projectId = '01990000-0000-7000-8000-000000002003'
const otherProjectId = '01990000-0000-7000-8000-000000002004'
const hiddenProjectId = '01990000-0000-7000-8000-000000002005'
const at = '2026-11-25T12:00:00.000Z'
let database: PGlite
const id = (value: number) => `01990000-0000-7000-8000-${String(value).padStart(12, '0')}`

async function insertNote(values: {
  id: string
  space: string
  projectId: string
  project: string
  number: number
  text: string
  stale?: boolean
  promoted?: boolean
}) {
  await database.query(
    `INSERT INTO hub_note
      (id,space_id,project_name,project_id,number,project,text,anchors,sightings,
       created_at,last_seen_at,stale_at,promoted_task,updated_at)
     VALUES ($1,$2,$3,$4,$5,$3,$6,'[]',1,$7,$7,$8,$9,$7)`,
    [
      values.id,
      values.space,
      values.project,
      values.projectId,
      values.number,
      values.text,
      at,
      values.stale ? at : null,
      values.promoted ? 'DEV-1' : null,
    ],
  )
}

beforeAll(async () => {
  database = await createHostedRecordFixture({ spaceId, userId })
  await database.exec(`
    RESET ROLE;
    INSERT INTO space (id,name,slug,created_at)
    VALUES ('${otherSpaceId}','Other','other',now());
    INSERT INTO project(id,space_id,name,created_at) VALUES
      ('${projectId}','${spaceId}','gamma','${at}'),
      ('${otherProjectId}','${spaceId}','delta','${at}'),
      ('${hiddenProjectId}','${otherSpaceId}','gamma','${at}');
  `)
  for (let index = 0; index < NOTE_DUPLICATE_CANDIDATES + 5; index += 1)
    await insertNote({
      id: id(2020 + index),
      space: spaceId,
      projectId,
      project: 'gamma',
      number: index + 3,
      text: `alpha filler${index}`,
    })
  for (let index = 0; index < NOTE_DUPLICATE_CANDIDATES; index += 1)
    await insertNote({
      id: id(3000 + index),
      space: spaceId,
      projectId,
      project: 'gamma',
      number: 100 + index,
      text: 'alpha beta',
    })
  await insertNote({
    id: id(2100),
    space: spaceId,
    projectId,
    project: 'gamma',
    number: 50,
    text: 'alpha beta',
    stale: true,
  })
  await insertNote({
    id: id(2101),
    space: spaceId,
    projectId,
    project: 'gamma',
    number: 51,
    text: 'alpha beta',
    promoted: true,
  })
  await insertNote({
    id: id(2102),
    space: spaceId,
    projectId: otherProjectId,
    project: 'delta',
    number: 1,
    text: 'alpha beta',
  })
  await insertNote({
    id: id(2103),
    space: otherSpaceId,
    projectId: hiddenProjectId,
    project: 'gamma',
    number: 1,
    text: 'alpha beta',
  })
  await database.exec('SET ROLE record_actor;')
})

afterAll(async () => {
  if (database) await database.close()
})

test('candidate read ranks and caps actionable project notes inside the caller tenancy', async () => {
  const rows = await listHostedNoteCandidates(
    pgliteSql(database),
    { userId, spaceId },
    'gamma',
    'alpha beta',
  )

  expect(rows).toHaveLength(NOTE_DUPLICATE_CANDIDATES)
  expect(rows.map((row) => row.record_id)).toEqual(
    Array.from({ length: NOTE_DUPLICATE_CANDIDATES }, (_, index) => id(3000 + index)),
  )
  expect(rows.every((row) => row.project === 'gamma' && row.stale_at === null)).toBe(true)
  expect(rows.map((row) => row.record_id)).not.toContain(id(2100))
  expect(rows.map((row) => row.record_id)).not.toContain(id(2101))
  expect(rows.map((row) => row.record_id)).not.toContain(id(2102))
  expect(rows.map((row) => row.record_id)).not.toContain(id(2103))
  expect(rows[0]).toEqual({
    record_id: id(3000),
    number: 100,
    label: 'gamma#100',
    project: 'gamma',
    text: 'alpha beta',
    stale_at: null,
  })
})
