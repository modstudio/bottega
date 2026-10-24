import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { db } from '../database/db.ts'
import { upsertProject } from '../project/projects.ts'
import { newestSuccessfulReleasedCommit, releaseLog } from './release-service.ts'

test('release readers use UUID to break a shared start-time tie', () => {
  const project = `release-order-${newRecordId()}`
  upsertProject({ recordId: newRecordId(), name: project, path: `/tmp/${project}` })
  const projectRecordId = (
    db().query('SELECT record_id FROM project WHERE name=?').get(project) as { record_id: string }
  ).record_id
  for (const [recordId, candidate] of [
    ['01990000-0000-7000-8000-000000000032', 'uuid-latest'],
    ['01990000-0000-7000-8000-000000000031', 'inserted-later'],
  ]) {
    db()
      .query(
        `INSERT INTO release_ledger(
           record_id,project,project_record_id,rung,candidate_commit,rollback,actor,started_at,
           finished_at,exit_code
         ) VALUES (?,?,?,'production',?,0,'operator','same-start','same-finish',0)`,
      )
      .run(recordId, project, projectRecordId, candidate)
  }
  expect(newestSuccessfulReleasedCommit(project, 'production')).toBe('uuid-latest')
  expect(releaseLog(project, 'production').map((row) => row.candidate_commit)).toEqual([
    'uuid-latest',
    'inserted-later',
  ])
})
