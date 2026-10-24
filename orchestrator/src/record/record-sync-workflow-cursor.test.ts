import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { MACHINE_ID, options, STAMP } from '../../test/fixtures/record-sync.ts'
import { fakePostgres } from '../../test/fixtures/record-sync-postgres.ts'
import { catalogueVersionRecordId, workflowVersionRecordId } from '../../test/fixtures/workflow.ts'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import { enqueueQuestionRecord } from '../run/question-outbox.ts'
import { syncRecord } from './record-sync.ts'

test('a workflow question pushes the cursor display number to the hosted bigint', async () => {
  const local = migratedTestDatabase()
  const cursor = local
    .query<{ record_id: string }, [string, string, string, string]>(
      `INSERT INTO workflow_cursor
       (record_id,number,project,workflow_slug,mode_slug,instance_id,
        workflow_version_record_id,catalogue_version_record_id,args,step_slug,total_steps,created_at,updated_at)
       VALUES ('${newRecordId()}',37,'fixture','ship-task','default','',?,?,'{}','step',1,?,?)
       RETURNING record_id`,
    )
    .get(workflowVersionRecordId(local), catalogueVersionRecordId(local), STAMP, STAMP)!
  const question = local
    .query<{ record_id: string }, [string, string]>(
      `INSERT INTO question
       (number,record_id,workflow_cursor_record_id,asked_at,question,asked_via)
       VALUES (1,'${newRecordId()}',?,?,'Which?','workflow') RETURNING record_id`,
    )
    .get(cursor.record_id, STAMP)!
  local
    .query("INSERT OR REPLACE INTO schema_meta (key,value) VALUES ('machine_id',?)")
    .run(MACHINE_ID)

  enqueueQuestionRecord(local, question.record_id)
  const payload = JSON.parse(
    local.query<{ payload: string }, []>("SELECT payload FROM outbox WHERE kind='question'").get()!
      .payload,
  ) as Record<string, unknown>
  expect(payload.workflowCursorId).toBe(37)

  const result = await syncRecord(options(local, fakePostgres()))
  expect(result).toMatchObject({ pushed: 1, failed: 0, pending: 0 })
  local.close()
})
