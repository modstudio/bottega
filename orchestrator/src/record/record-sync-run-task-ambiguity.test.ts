import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { RECORD_ACTOR_ROLE } from '../../../shared/record/schema.ts'
import { localOutbox, options, RECORD_ID } from '../../test/fixtures/record-sync.ts'
import { fakePostgres } from '../../test/fixtures/record-sync-postgres.ts'
import { syncRecord } from './record-sync.ts'

test('run sync stores no task link when its key matches two live hosted tasks', async () => {
  const taskKey = 'DEV-1771'
  const spaceId = '01990000-0000-7000-8000-000000000001'
  const local = localOutbox(1, PLATFORM_SLUG, { taskId: null, taskKey })
  const remote = fakePostgres(
    false,
    RECORD_ACTOR_ROLE,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    [
      { id: '01990000-0000-7000-8000-000000001771', spaceId, key: taskKey },
      { id: '01990000-0000-7000-8000-000000001772', spaceId, key: taskKey },
    ],
  )

  expect(await syncRecord(options(local, remote))).toMatchObject({ pushed: 1, failed: 0 })
  const runWrite = remote.statements.find((sql) => sql.toLowerCase().includes('insert into "run"'))!
  const columns = runWrite
    .slice(runWrite.indexOf('(') + 1, runWrite.indexOf(')'))
    .split(',')
    .map((column) => column.replaceAll('"', '').trim())
  const runId = `${RECORD_ID.slice(0, -1)}1`
  const parameters = remote.parameters.find(
    (values) => values.includes(runId) && values.includes(taskKey),
  )!
  expect(parameters[columns.indexOf('task_id')]).toBeNull()
  local.close()
})

function runColumn(remote: ReturnType<typeof fakePostgres>, runId: string, column: string) {
  const runWrite = remote.statements.find((sql) => sql.toLowerCase().includes('insert into "run"'))!
  const columns = runWrite
    .slice(runWrite.indexOf('(') + 1, runWrite.indexOf(')'))
    .split(',')
    .map((name) => name.replaceAll('"', '').trim())
  const parameters = remote.parameters.find(
    (values) => values.length >= columns.length && values.includes(runId),
  )!
  return parameters[columns.indexOf(column)]
}

test('a run with a task and no project takes its hosted task project', async () => {
  const spaceId = '01990000-0000-7000-8000-000000000001'
  const taskId = '01990000-0000-7000-8000-000000001774'
  const taskProjectId = '01990000-0000-7000-8000-00000000a774'
  const local = localOutbox(1, null, { taskId, taskKey: 'DEV-1774', probe: false })
  const remote = fakePostgres(
    false,
    RECORD_ACTOR_ROLE,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    [{ id: taskId, spaceId, key: 'DEV-1774', projectId: taskProjectId }],
  )

  expect(await syncRecord(options(local, remote))).toMatchObject({ pushed: 1, failed: 0 })
  const runId = `${RECORD_ID.slice(0, -1)}1`
  expect(runColumn(remote, runId, 'task_id')).toBe(taskId)
  expect(runColumn(remote, runId, 'project_id')).toBe(taskProjectId)
  local.close()
})

test('a non-probe run with neither a task nor a project is refused', async () => {
  const local = localOutbox(1, null, { taskId: null, taskKey: null, probe: false })
  const remote = fakePostgres(false, RECORD_ACTOR_ROLE)

  expect(await syncRecord(options(local, remote))).toMatchObject({ pushed: 0, failed: 1 })
  const row = local.query<{ last_error: string }, []>('SELECT last_error FROM outbox').get()!
  expect(row.last_error).toContain('has no hosted project or task')
  const runWrites = remote.statements.filter((sql) =>
    sql.toLowerCase().includes('insert into "run"'),
  )
  expect(runWrites).toHaveLength(0)
  local.close()
})
