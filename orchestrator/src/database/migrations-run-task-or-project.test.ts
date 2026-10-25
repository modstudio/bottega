import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { applyMigrations } from './migrations.ts'
import { migrationBoundaryTestDatabase } from './test-database.fixture.ts'

const MIGRATION = '0167_run_task_or_project'
const REFUSAL =
  'a run that is not a probe must reference a task or a project; run from a registered project or pass a task key'

function insertRun(database: ReturnType<typeof migrationBoundaryTestDatabase>, probe = 0): string {
  const recordId = newRecordId()
  database
    .query(
      `INSERT INTO run
       (record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,probe)
       VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM run),'at','codex','understand','sha',1,'head','ok',?)`,
    )
    .run(recordId, probe)
  return recordId
}

test('requires every non-probe run to reference a task or project', () => {
  const database = migrationBoundaryTestDatabase(MIGRATION)
  try {
    const projectId = newRecordId()
    database
      .query("INSERT INTO project(record_id,name,path,settings) VALUES (?,'alpha','/alpha','{}')")
      .run(projectId)
    const linkedRun = insertRun(database)
    database.query('UPDATE run SET project_record_id=? WHERE record_id=?').run(projectId, linkedRun)

    expect(applyMigrations(database)).toContain(MIGRATION)
    expect(() => insertRun(database)).toThrow(REFUSAL)
    expect(() => insertRun(database, 1)).not.toThrow()
    expect(() =>
      database
        .query('UPDATE run SET project_record_id=NULL,task_record_id=NULL WHERE record_id=?')
        .run(linkedRun),
    ).toThrow(REFUSAL)
  } finally {
    database.close()
  }
})
