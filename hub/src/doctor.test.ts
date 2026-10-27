import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { newRecordId } from '../../shared/record/schema.ts'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { writeTransaction } from './db.ts'
import { hubDoctorLines, INTERVAL_UNLINKED_KEY_LIMIT } from './doctor.ts'

beforeEach(resetFixtureStore)
afterAll(resetFixtureStore)

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
    expect(await hubDoctorLines()).toContain('interval links unlinked task keys MISSING-1 (1)')
  })

  test('reports each unlinked question and commit task-key column', async () => {
    writeTransaction((conn) =>
      conn.exec(`
        INSERT INTO question(record_id,number,run_record_id,root_run_record_id,task_key,workflow_key,asked_at)
        VALUES
          ('question-missing-a',1,'00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','TASK-MISSING','WORKFLOW-MISSING','2026-10-25'),
          ('question-missing-b',2,'00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000002','TASK-MISSING',NULL,'2026-10-25');
        INSERT INTO commit_key(sha,repo,task_key,at)
        VALUES ('commit-missing','alpha','COMMIT-MISSING','2026-10-25');
      `),
    )
    const lines = await hubDoctorLines()
    expect(lines).toContain('question.task_key links unlinked task keys TASK-MISSING (2)')
    expect(lines).toContain('question.workflow_key links unlinked task keys WORKFLOW-MISSING (1)')
    expect(lines).toContain('commit_key.task_key links unlinked task keys COMMIT-MISSING (1)')
  })

  test('caps named unlinked keys and separately reports intervals with neither link', async () => {
    writeTransaction((conn) => {
      const insert = conn.query(
        `INSERT INTO interval
         (record_id,task_key,project_record_id,source,start_at,end_at,ref)
         VALUES (?, ?, 'project-id', 'orch', '2026-10-25', '2026-10-25', ?)`,
      )
      for (let index = 0; index < INTERVAL_UNLINKED_KEY_LIMIT + 2; index++)
        insert.run(newRecordId(), `MISSING-${index}`, `run-${index}`)
      conn.exec(`
        DROP TRIGGER interval_require_task_or_project_insert;
        INSERT INTO interval(record_id,source,start_at,end_at,ref)
        VALUES ('legacy-neither','orch','2026-10-25','2026-10-25','legacy-neither')
      `)
    })
    const lines = await hubDoctorLines()
    expect(lines.find((line) => line.startsWith('interval links unlinked task keys'))).toEndWith(
      'and 2 more',
    )
    expect(lines).toContain('interval links 1 interval with neither task nor project')
  })
})
