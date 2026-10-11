import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { PGlite } from '@electric-sql/pglite'
import { createHostedRecordFixture, pgliteSql } from '../test/hosted-record-fixture.ts'
import { type HostedTask, mirrorHostedTaskBody } from './hosted-tasks.ts'

const spaceId = '01990000-0000-7000-8000-000000001250'
const firstId = '01990000-0000-7000-8000-000000001251'
const secondId = '01990000-0000-7000-8000-000000001252'
const userId = '01990000-0000-7000-8000-000000001249'
const identity = { userId, spaceId }
const task = (id: string, key: string, title: string, at: string): HostedTask => ({
  id,
  key,
  project: 'workshop',
  project_name: 'workshop',
  title,
  status: 'active',
  status_category: 'active',
  parent_key: null,
  body: null,
  assignee: null,
  opened_at: '2026-10-09T10:00:00.000Z',
  closed_at: null,
  source: 'mcp',
  first_seen: '2026-10-09T10:00:00.000Z',
  last_seen: at,
  created_at: '2026-10-09T10:00:00.000Z',
  updated_at: at,
  deleted_at: null,
  next_document_number: 1,
})

let database: PGlite
beforeAll(async () => {
  database = await createHostedRecordFixture({ spaceId, userId })
})
afterAll(async () => {
  if (database) await database.close()
})

test('task mirroring writes only changed or missing hosted rows', async () => {
  const sql = pgliteSql(database)
  const firstAt = '2026-10-09T11:00:00.000Z'
  const changedAt = '2026-10-09T12:00:00.000Z'
  const first = task(firstId, 'DEV-1', 'First', firstAt)
  const second = task(secondId, 'DEV-2', 'Second', firstAt)
  await mirrorHostedTaskBody(sql, identity, { tasks: [first, second] }, 2)
  const afterFirst = await database.query<{ id: string; updated_at: string }>(
    `SELECT id::text,updated_at::text FROM hub_task ORDER BY id`,
  )
  expect(
    (
      await database.query<{ count: number }>(
        `SELECT count(*)::int count FROM hub_change WHERE table_name='hub_task'`,
      )
    ).rows[0]?.count,
  ).toBe(2)
  await mirrorHostedTaskBody(
    sql,
    identity,
    {
      tasks: [
        { ...first, first_seen: changedAt, last_seen: changedAt },
        { ...second, first_seen: changedAt, last_seen: changedAt },
      ],
    },
    2,
  )
  expect(
    (
      await database.query<{ count: number }>(
        `SELECT count(*)::int count FROM hub_change WHERE table_name='hub_task'`,
      )
    ).rows[0]?.count,
  ).toBe(2)
  expect(
    (await database.query(`SELECT id::text,updated_at::text FROM hub_task ORDER BY id`)).rows,
  ).toEqual(afterFirst.rows)
  await mirrorHostedTaskBody(
    sql,
    identity,
    {
      tasks: [{ ...first, title: 'Changed first', updated_at: changedAt, last_seen: changedAt }],
    },
    1,
  )
  expect(
    (
      await database.query<{ count: number }>(
        `SELECT count(*)::int count FROM hub_change WHERE table_name='hub_task'`,
      )
    ).rows[0]?.count,
  ).toBe(3)
  expect(
    (
      await database.query<{ id: string; updated_at: string; first_seen: string }>(
        `SELECT id::text,updated_at::text,first_seen::text FROM hub_task ORDER BY id`,
      )
    ).rows,
  ).toEqual([
    { id: firstId, updated_at: '2026-10-09 12:00:00+00', first_seen: '2026-10-09 10:00:00+00' },
    { id: secondId, updated_at: '2026-10-09 11:00:00+00', first_seen: '2026-10-09 10:00:00+00' },
  ])
  await database.query(`DELETE FROM hub_task WHERE id=$1`, [secondId])
  const beforeHealing = (
    await database.query<{ count: number }>(
      `SELECT count(*)::int count FROM hub_change WHERE table_name='hub_task'`,
    )
  ).rows[0]!.count
  await mirrorHostedTaskBody(sql, identity, { tasks: [second] }, 1)
  expect(
    (
      await database.query<{ count: number }>(
        `SELECT count(*)::int count FROM hub_change WHERE table_name='hub_task'`,
      )
    ).rows[0]?.count,
  ).toBe(beforeHealing + 1)
  expect((await database.query(`SELECT title FROM hub_task WHERE id=$1`, [secondId])).rows).toEqual(
    [{ title: 'Second' }],
  )
})
