import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { PGlite } from '@electric-sql/pglite'
import type { SQL } from 'bun'
import { createHostedRecordFixture, pgliteSql } from './hosted-record.ts'

let database: PGlite
let sql: SQL

beforeAll(async () => {
  database = await createHostedRecordFixture({
    spaceId: '01990000-0000-7000-8000-000000024596',
    userId: '01990000-0000-7000-8000-000000024597',
  })
  sql = pgliteSql(database)
})

afterAll(async () => database?.close())

test('pglite SQL composes two parameterized fragments', async () => {
  const left = sql`${2}::integer + ${3}::integer`
  const right = sql`${5}::integer * ${7}::integer`
  expect(await sql`SELECT ${left} AS left, ${right} AS right`).toEqual([{ left: 5, right: 35 }])
})

test('pglite SQL composes a parameterized fragment recursively', async () => {
  const inner = sql`${2}::integer + ${3}::integer`
  const outer = sql`(${inner}) * ${4}::integer`
  expect(await sql`SELECT ${outer} AS value`).toEqual([{ value: 20 }])
})
