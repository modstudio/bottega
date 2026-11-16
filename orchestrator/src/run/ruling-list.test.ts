import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { catalogueVersionRecordId, workflowVersionRecordId } from '../../test/fixtures/workflow.ts'
import { db } from '../database/db.ts'
import { listRulings } from './ruling-list.ts'

test('ruling list strips question-store fields outside the published contract', async () => {
  const cursorId = newRecordId()
  db()
    .query(
      `INSERT INTO workflow_cursor
        (record_id,number,project,workflow_slug,mode_slug,workflow_key,instance_id,
         workflow_version_record_id,catalogue_version_record_id,args,ordinal,step_slug,state,closed,
         question,total_steps,created_at,updated_at)
       VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM workflow_cursor),'fixture','ship-task',
               'default','DEV-2349','',?,?,'{}',0,'build','running','[]',NULL,1,
               '2026-11-16T01:00:00.000Z','2026-11-16T01:00:00.000Z')`,
    )
    .run(cursorId, workflowVersionRecordId(db()), catalogueVersionRecordId(db()))

  const questionId = newRecordId()
  db()
    .query(
      `INSERT INTO question
        (record_id,number,workflow_cursor_record_id,workflow_key,workflow_task_record_id,
         asked_at,question,answer,answered_at,kind,jev_pick,asked_via,answerer_kind)
       VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM question),?,'DEV-2349','task-DEV-2349',
               '2026-11-16T01:01:00.000Z','Which option?','Alpha',
               '2026-11-16T01:02:00.000Z','choice','\"alpha\"','workflow','operator')`,
    )
    .run(questionId, cursorId)

  const rows = await listRulings({ kind: 'all' })

  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ record_id: questionId, answer: 'Alpha' })
  expect(rows[0]).not.toHaveProperty('jev_pick')
})
