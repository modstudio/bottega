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
