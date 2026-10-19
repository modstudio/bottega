import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { PGlite } from '@electric-sql/pglite'
import { PLATFORM_NAME } from '../../shared/brand.ts'
import { createHostedRecordFixture, pgliteSql } from '../test/hosted-record-fixture.ts'
import { listHostedTasks } from './hosted-task-list.ts'

const spaceId = '01990000-0000-7000-8000-000000001510'
const userId = '01990000-0000-7000-8000-000000001511'
const at = '2026-10-19T12:00:00.123456Z'
let database: PGlite

const id = (value: number) => `01990000-0000-7000-8000-${String(value).padStart(12, '0')}`

beforeAll(async () => {
  database = await createHostedRecordFixture({ spaceId, userId })
  const tasks = Array.from({ length: 5 }, (_, index) => {
    const taskId = id(1512 + index)
    return `('${taskId}','${spaceId}','${PLATFORM_NAME}','DEV-${index + 1}','${PLATFORM_NAME}','Task ${index + 1}',
      'local','${at}','${at}','${at}','${at}')`
  }).join(',')
  await database.exec(`
    RESET ROLE;
    INSERT INTO hub_task
      (id,space_id,project_name,key,project,title,source,first_seen,last_seen,created_at,updated_at)
    VALUES ${tasks};
    INSERT INTO hub_task_comment
      (id,space_id,project_name,task_key,task_id,body,created_at,updated_at)
    VALUES
      ('${id(1520)}','${spaceId}','${PLATFORM_NAME}','DEV-1','${id(1512)}','Comment 1','${at}','${at}'),
      ('${id(1521)}','${spaceId}','${PLATFORM_NAME}','DEV-2','${id(1513)}','Comment 2','${at}','${at}');
    INSERT INTO hub_task_document
      (id,space_id,project_name,task_key,task_id,number,role,title,body,version,created_at,updated_at)
    VALUES
      ('${id(1530)}','${spaceId}','${PLATFORM_NAME}','DEV-1','${id(1512)}',1,'handoff','Doc 1','Body','v1','${at}','${at}'),
      ('${id(1531)}','${spaceId}','${PLATFORM_NAME}','DEV-2','${id(1513)}',1,'handoff','Doc 2','Body','v1','${at}','${at}');
    SET ROLE record_actor;
  `)
})

afterAll(async () => {
  if (database) await database.close()
})

test('a first task pull pages shared timestamps without repeating rows or exposing children first', async () => {
  const pages = []
  let cursor: string | undefined
  do {
    const page = await listHostedTasks(
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

  expect(pages.length).toBeGreaterThan(2)
  expect(
    pages.every(
      (page) =>
        page.tasks.length +
          page.comments.length +
          page.documents.length +
          page.statusEvents.length <=
        2,
    ),
  ).toBe(true)
  const received = pages.flatMap((page) => [
    ...page.tasks.map((row) => `task:${row.id}`),
    ...page.comments.map((row) => `comment:${row.id}`),
    ...page.documents.map((row) => `document:${row.id}`),
  ])
  expect(received).toHaveLength(9)
  expect(new Set(received).size).toBe(received.length)
  expect(received.slice(0, 5).every((row) => row.startsWith('task:'))).toBe(true)
})
