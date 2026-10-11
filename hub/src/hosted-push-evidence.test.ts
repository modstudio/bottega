import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { PGlite } from '@electric-sql/pglite'
import type { SQL } from 'bun'
import { createHostedRecordFixture, pgliteSql } from '../test/hosted-record-fixture.ts'
import { applyHostedPushChangesInTransaction } from './hosted-push-changes.ts'
import {
  type HostedPushChange,
  type PushedDay,
  type PushedInterval,
  parseHostedPushItem,
} from './push-contract.ts'

const spaceId = '01990000-0000-7000-8000-000000008301'
const userId = '01990000-0000-7000-8000-000000008302'
const intervalId = '01990000-0000-7000-8000-000000008303'
const dayId = '01990000-0000-7000-8000-000000008304'
const identity = { userId, spaceId }
let database: PGlite

const interval: PushedInterval = {
  id: intervalId,
  task_key: null,
  project_name: 'workshop',
  source: 'orch',
  agent: null,
  job: null,
  start_at: '2026-10-11T10:00:00.000Z',
  end_at: '2026-10-11T10:01:00.000Z',
  claude_tokens: 10,
  vendor_tokens: 20,
  vendor_cost_usd: null,
  ref: 'orch:8303',
  via: null,
  open: 0,
  session_id: null,
  user_id: null,
}
const day: PushedDay = {
  id: dayId,
  day: '2026-10-11',
  claude_tokens: 10,
  cache_read: 0,
  messages: 1,
  tasks: 1,
  canon_tokens: 0,
  other_tokens: 0,
  commits: 1,
  files: 1,
  lines_product: 1,
  lines_test: 0,
  lines_docs: 0,
  lines_config: 0,
  lines_generated: 0,
  collected_at: '2026-10-11T23:00:00.000Z',
}

const apply = (inputs: HostedPushChange[]) =>
  database.transaction(async (transaction) => {
    const sql = pgliteSql(transaction as unknown as PGlite)
    sql.unsafe = (async (statement: string) =>
      (await transaction.query(statement)).rows) as SQL['unsafe']
    return applyHostedPushChangesInTransaction(sql, identity, inputs)
  })

beforeAll(async () => {
  database = await createHostedRecordFixture({ spaceId, userId })
})

afterAll(async () => {
  if (database) await database.close()
})

test('the edge accepts evidence and unchanged resends append no hosted changes', async () => {
  const inputs: HostedPushChange[] = [
    { table: 'hub_interval', id: intervalId, op: 'upsert', row: interval },
    { table: 'hub_day', id: dayId, op: 'upsert', row: day },
  ]
  expect(inputs.map(parseHostedPushItem)).toEqual(inputs.map((input) => ({ input })))
  expect(await apply(inputs)).toEqual([
    { id: intervalId, status: 'applied' },
    { id: dayId, status: 'applied' },
  ])
  const before = (
    await database.query<{ count: number }>(
      `SELECT count(*)::int count FROM hub_change WHERE table_name IN ('hub_interval','hub_day')`,
    )
  ).rows[0]!.count
  expect(await apply(inputs)).toEqual([
    { id: intervalId, status: 'duplicate' },
    { id: dayId, status: 'duplicate' },
  ])
  const after = (
    await database.query<{ count: number }>(
      `SELECT count(*)::int count FROM hub_change WHERE table_name IN ('hub_interval','hub_day')`,
    )
  ).rows[0]!.count
  expect(after).toBe(before)
})

test('an absent interval delete is duplicate and a present interval delete applies', async () => {
  const absent = '01990000-0000-7000-8000-000000008305'
  expect(await apply([{ table: 'hub_interval', id: absent, op: 'delete' }])).toEqual([
    { id: absent, status: 'duplicate' },
  ])
  expect(await apply([{ table: 'hub_interval', id: intervalId, op: 'delete' }])).toEqual([
    { id: intervalId, status: 'applied' },
  ])
})
