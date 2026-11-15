import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { applyMigrations } from './migrations.ts'
import { migrationBoundaryTestDatabase } from './test-database.fixture.ts'

test('run stack backfill fills only unknown rows from a nonblank registered stack', () => {
  const database = migrationBoundaryTestDatabase('0225_run_stack_backfill')
  const knownProject = newRecordId()
  const unknownProject = newRecordId()
  database
    .query(
      "INSERT INTO project(record_id,name,path,stack,settings) VALUES (?,'known','/known',' bun ','{}')",
    )
    .run(knownProject)
  database
    .query(
      "INSERT INTO project(record_id,name,path,stack,settings) VALUES (?,'unknown','/unknown',' ','{}')",
    )
    .run(unknownProject)
  const insert = database.query(
    `INSERT INTO run(record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,project_record_id,stack)
     VALUES (?,?,'2026-11-14','codex','implement','sha',1,'head','ok',?,?)`,
  )
  insert.run(newRecordId(), 1, knownProject, null)
  insert.run(newRecordId(), 2, knownProject, '')
  insert.run(newRecordId(), 3, knownProject, 'typescript')
  insert.run(newRecordId(), 4, unknownProject, null)

  expect(applyMigrations(database)).toContain('0225_run_stack_backfill')
  expect(database.query('SELECT number,stack FROM run ORDER BY number').all()).toEqual([
    { number: 1, stack: 'bun' },
    { number: 2, stack: 'bun' },
    { number: 3, stack: 'typescript' },
    { number: 4, stack: null },
  ])
  database.close()
})
