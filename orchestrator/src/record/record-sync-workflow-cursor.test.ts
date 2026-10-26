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
       (number,record_id,workflow_cursor_record_id,asked_at,question,asked_via,
        answered_by_name,overturned_by_name)
       VALUES (1,'${newRecordId()}',?,?,'Which?','workflow','Ada Lovelace','Grace Hopper')
       RETURNING record_id`,
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
  return {
    columns,
    recordId: parameters[columns.indexOf('workflow_cursor_record_id')],
    valueFor: (column: string) => parameters[columns.indexOf(column)],
  }
}

test('a workflow question pushes only the cursor UUID', async () => {
  const { cursorId, local } = workflowQuestionOutbox()
  const payload = questionPayload(local)
  expect(payload.workflowCursorRecordId).toBe(cursorId)

  const remote = fakePostgres()
  const result = await syncRecord(options(local, remote))
  expect(result).toMatchObject({ pushed: 1, failed: 0, pending: 0 })
  expect(hostedQuestionCursor(remote, cursorId)).toMatchObject({
    columns: expect.not.arrayContaining(['workflow_cursor_id']),
    recordId: cursorId,
  })
  local.close()
})

test('the hosted question edge stores an optional workflow task UUID', async () => {
  const workflowTaskId = '01990000-0000-7000-8000-000000000943'
  const { cursorId, local } = workflowQuestionOutbox()
  replaceQuestionPayload(local, (payload) => {
    payload.workflowTaskId = workflowTaskId
  })

  const remote = fakePostgres()
  expect(await syncRecord(options(local, remote))).toMatchObject({ pushed: 1, failed: 0 })
  expect(hostedQuestionCursor(remote, cursorId).valueFor('workflow_task_id')).toBe(workflowTaskId)
  local.close()
})

test('the hosted question edge stores null when an older client omits the workflow task UUID', async () => {
  const { cursorId, local } = workflowQuestionOutbox()
  replaceQuestionPayload(local, (payload) => {
    delete payload.workflowTaskId
  })

  const remote = fakePostgres()
  expect(await syncRecord(options(local, remote))).toMatchObject({ pushed: 1, failed: 0 })
  expect(hostedQuestionCursor(remote, cursorId).valueFor('workflow_task_id')).toBeNull()
  local.close()
})

test('a K7c-1 question payload syncs and its cursor number is discarded', async () => {
  for (const workflowCursorId of [null, 37]) {
    const { cursorId, local } = workflowQuestionOutbox()
    replaceQuestionPayload(local, (payload) => {
      payload.workflowCursorId = workflowCursorId
    })

    const remote = fakePostgres()
    expect(await syncRecord(options(local, remote))).toMatchObject({
      pushed: 1,
      failed: 0,
      pending: 0,
    })
    expect(hostedQuestionCursor(remote, cursorId)).toMatchObject({
      columns: expect.not.arrayContaining(['workflow_cursor_id']),
      recordId: cursorId,
    })
    local.close()
  }
})

test('an old-shape question payload without ruling names is accepted', async () => {
  const { local } = workflowQuestionOutbox()
  replaceQuestionPayload(local, (payload) => {
    delete payload.answeredByName
    delete payload.overturnedByName
  })

  const remote = fakePostgres()
  expect(await syncRecord(options(local, remote))).toMatchObject({
    pushed: 1,
    failed: 0,
    pending: 0,
  })
  local.close()
})

test('question ruling names reach the hosted record', async () => {
  const { cursorId, local } = workflowQuestionOutbox()
  const remote = fakePostgres()
  expect(await syncRecord(options(local, remote))).toMatchObject({
    pushed: 1,
    failed: 0,
    pending: 0,
  })
  const hosted = hostedQuestionCursor(remote, cursorId)
  expect(hosted.valueFor('answered_by_name')).toBe('Ada Lovelace')
  expect(hosted.valueFor('overturned_by_name')).toBe('Grace Hopper')
  local.close()
})
