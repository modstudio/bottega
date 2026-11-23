import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db, nowIso } from '../database/db.ts'
import { fixtureProjectRecordId } from '../database/test-database.fixture.ts'
import { rememberProjectSpace } from '../project-space-cache.ts'
import { readWorkerTask } from './worker-record-broker.ts'
import type { WorkerHostedTaskDetail, WorkerRecordClient } from './worker-record-client.ts'
import {
  processWorkerRecordReadRequest,
  startWorkerRecordReadBroker,
} from './worker-record-read-broker.ts'
import { requestWorkerRecordRead } from './worker-record-read-request.ts'

const SPACE_ID = '01990000-0000-7000-8000-000000000001'
const TASK_ID = '01990000-0000-7000-8000-000000000002'

function setup() {
  const projectId = fixtureProjectRecordId(db())
  const project = db()
    .query<{ name: string }, [string]>('SELECT name FROM project WHERE record_id=?')
    .get(projectId)!.name
  rememberProjectSpace(db(), project, SPACE_ID)
  const runId = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'running',
    taskRecordId: TASK_ID,
    projectRecordId: projectId,
  })
  db()
    .query('UPDATE run SET launch_key=?,run_token=? WHERE record_id=?')
    .run('DEV-2', 'run-token', runId)
  const detail: WorkerHostedTaskDetail = {
    task: {
      id: TASK_ID,
      key: 'DEV-2',
      projectId,
      parent_id: null,
      parent_key: null,
    },
    comments: [],
    documents: [],
  }
  const client: WorkerRecordClient = {
    task: async () => detail,
    workflowText: async () => null,
    workflowStage: async () => null,
  }
  return { client, project, runId }
}

test('queue transport records the canonical scope refusal', async () => {
  const { client, runId } = setup()
  let expected = ''
  try {
    await readWorkerTask(runId, 'run-token', 'DEV-9', undefined, { client })
  } catch (error) {
    expected = error instanceof Error ? error.message : String(error)
  }
  const recordId = newRecordId()
  db()
    .query(
      `INSERT INTO worker_record_read_request
       (record_id,run_record_id,kind,reference,status,requested_at)
       VALUES (?,?,'task','DEV-9','requested',?)`,
    )
    .run(recordId, runId, nowIso())

  expect(await processWorkerRecordReadRequest(runId, 'run-token', client)).toBe(true)
  expect(
    db()
      .query('SELECT status,refusal FROM worker_record_read_request WHERE record_id=?')
      .get(recordId),
  ).toEqual({ status: 'refused', refusal: expected })
})

test('request results and broker close both remove queue rows', async () => {
  const { client, runId } = setup()
  const result = requestWorkerRecordRead({ runId, kind: 'task', reference: 'DEV-2' })
  expect(await processWorkerRecordReadRequest(runId, 'run-token', client)).toBe(true)
  expect(JSON.parse(await result)).toMatchObject({ task: { key: 'DEV-2' } })
  expect(
    db().query('SELECT count(*) count FROM worker_record_read_request').get(),
  ).toEqual({ count: 0 })

  db()
    .query(
      `INSERT INTO worker_record_read_request
       (record_id,run_record_id,kind,reference,status,requested_at)
       VALUES (?,?,'task','DEV-2','requested',?)`,
    )
    .run(newRecordId(), runId, nowIso())
  const broker = startWorkerRecordReadBroker(runId, 'run-token', client)
  await broker.close()
  expect(
    db().query('SELECT count(*) count FROM worker_record_read_request').get(),
  ).toEqual({ count: 0 })
})
