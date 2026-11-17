import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { PGlite } from '@electric-sql/pglite'
import { createHostedRecordFixture } from '../../test/fixtures/hosted-record.ts'

const spaceId = '01990000-0000-7000-8000-000000006001'
const userId = '01990000-0000-7000-8000-000000006002'
const lookupId = '01990000-0000-7000-8000-000000006003'

let database: PGlite

beforeAll(async () => {
  database = await createHostedRecordFixture({ spaceId, userId })
  await database.exec('SET enable_seqscan=off')
})

afterAll(async () => {
  if (database) await database.close()
})

test('hot hosted record predicates are applied as index conditions', async () => {
  const lookups = [
    { table: 'question', column: 'run_id' },
    { table: 'question', column: 'workflow_cursor_record_id' },
    { table: 'run', column: 'parent_run_id' },
  ] as const

  for (const { table, column } of lookups) {
    const result = await database.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN (COSTS OFF) SELECT id FROM "${table}" WHERE "${column}"=$1`,
      [lookupId],
    )
    const plan = result.rows.map((row) => row['QUERY PLAN']).join('\n')
    expect(plan).toMatch(new RegExp(`Index Cond: .*${column}`))
  }
})
