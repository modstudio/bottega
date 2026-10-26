import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { newRecordId } from '../../shared/record/schema.ts'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { writeTransaction } from './db.ts'
import { hubDoctorLines } from './doctor.ts'

beforeAll(resetFixtureStore)

describe(`${PLATFORM_SLUG} machine doctor`, () => {
  const previousHostedUrl = process.env.BOTTEGA_HOSTED_URL
  beforeAll(() => {
    delete process.env.BOTTEGA_HOSTED_URL
  })
  afterAll(() => {
    if (previousHostedUrl === undefined) delete process.env.BOTTEGA_HOSTED_URL
    else process.env.BOTTEGA_HOSTED_URL = previousHostedUrl
  })

  test('reports the write mode of each registered project', async () => {
    const lines = await hubDoctorLines()
    expect(lines.some((line) => line.startsWith('install        never-bound'))).toBe(true)
    expect(lines.some((line) => line.startsWith('write mode     local-authoritative'))).toBe(true)
    expect(lines.some((line) => /\balpha\b/.test(line) && line.includes('refused'))).toBe(true)
    expect(
      lines.some((line) => /\bworkshop\b/.test(line) && line.includes('local-authoritative')),
    ).toBe(true)
  })

  test('reports intervals whose task display key has no UUID link', async () => {
    writeTransaction((conn) =>
      conn
        .query(
          `INSERT INTO interval
           (record_id,task_key,project_record_id,source,start_at,end_at,ref)
           VALUES (?, 'MISSING-1', 'project-id', 'orch', '2026-10-25', '2026-10-25', 'run')`,
        )
        .run(newRecordId()),
    )
    expect(await hubDoctorLines()).toContain('interval links 1 task-key interval unlinked')
  })
})
