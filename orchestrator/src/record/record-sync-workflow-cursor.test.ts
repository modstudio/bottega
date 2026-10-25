import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { MACHINE_ID, options, STAMP } from '../../test/fixtures/record-sync.ts'
import { fakePostgres } from '../../test/fixtures/record-sync-postgres.ts'
import { catalogueVersionRecordId, workflowVersionRecordId } from '../../test/fixtures/workflow.ts'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import { enqueueQuestionRecord } from '../run/question-outbox.ts'
import { syncRecord } from './record-sync.ts'

function workflowQuestionOutbox() {
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
  return { cursorId: cursor.record_id, local }
}

function questionPayload(local: ReturnType<typeof migratedTestDatabase>) {
  return JSON.parse(
    local.query<{ payload: string }, []>("SELECT payload FROM outbox WHERE kind='question'").get()!
      .payload,
  ) as Record<string, unknown>
}

function replaceQuestionPayload(
  local: ReturnType<typeof migratedTestDatabase>,
  mutate: (payload: Record<string, unknown>) => void,
) {
  const payload = questionPayload(local)
  mutate(payload)
  local.query("UPDATE outbox SET payload=? WHERE kind='question'").run(JSON.stringify(payload))
}

function hostedQuestionCursor(remote: ReturnType<typeof fakePostgres>, marker: unknown) {
  const write = remote.statements.find((sql) =>
    sql.toLowerCase().includes('insert into "question"'),
  )!
  const columns = write
    .slice(write.indexOf('(') + 1, write.indexOf(')'))
    .split(',')
    .map((column) => column.replaceAll('"', '').trim())
  const parameters = remote.parameters.find((values) => values.includes(marker))!
  return parameters[columns.indexOf('workflow_cursor_record_id')]
}

test('a workflow question pushes only the cursor UUID', async () => {
  const { cursorId, local } = workflowQuestionOutbox()
  const payload = questionPayload(local)
  expect(payload.workflowCursorRecordId).toBe(cursorId)
  expect(payload).not.toHaveProperty('workflowCursorId')

  const remote = fakePostgres()
  const result = await syncRecord(options(local, remote))
  expect(result).toMatchObject({ pushed: 1, failed: 0, pending: 0 })
  expect(hostedQuestionCursor(remote, cursorId)).toBe(cursorId)
  local.close()
})

test('a K7c-1 question payload is held until the client updates', async () => {
  const { local } = workflowQuestionOutbox()
  replaceQuestionPayload(local, (payload) => {
    payload.workflowCursorId = null
  })

  expect(await syncRecord(options(local, fakePostgres()))).toMatchObject({
    pushed: 0,
    failed: 0,
    pending: 1,
    quarantined: [],
    held: [
      {
        kind: 'question',
        rows: 1,
        reason: expect.stringContaining('unknown columns: workflowCursorId'),
      },
    ],
  })
  expect(local.query('SELECT synced_at,quarantined_at FROM outbox').get()).toEqual({
    synced_at: null,
    quarantined_at: null,
  })
  local.close()
})
