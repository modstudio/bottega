import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { PGlite } from '@electric-sql/pglite'
import { createHostedRecordFixture } from '../test/hosted-record-fixture.ts'

const spaceId = '01990000-0000-7000-8000-000000001450'
const userId = '01990000-0000-7000-8000-000000001451'
let database: PGlite

beforeAll(async () => {
  database = await createHostedRecordFixture({ spaceId, userId })
})

afterAll(async () => {
  await database.close()
})

test('applied change retention prunes only rows older than its window', async () => {
  await database.exec(`
    INSERT INTO hub_applied_change(change_id,space_id,result,applied_at) VALUES
      ('01990000-0000-7000-8000-000000001452','${spaceId}','{}',now() - interval '31 days'),
      ('01990000-0000-7000-8000-000000001453','${spaceId}','{}',now() - interval '29 days');
  `)
  expect(
    (await database.query(`SELECT public.hub_applied_change_prune(30)::int AS deleted`)).rows,
  ).toEqual([{ deleted: 1 }])
  expect(
    (
      await database.query(`SELECT change_id::text FROM hub_applied_change WHERE change_id=$1`, [
        '01990000-0000-7000-8000-000000001453',
      ])
    ).rows,
  ).toHaveLength(1)
})
