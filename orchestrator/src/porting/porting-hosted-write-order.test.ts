import { afterEach, expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record/schema.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { db } from '../database/db.ts'
import {
  addDoctrineRule,
  addSkip,
  removeLedgerRef,
  resolveLedgerRef,
  retireDoctrineRule,
  setBaselineForProjects,
  setLedgerRef,
} from './porting.ts'

const space = '01990000-0000-7000-8000-000000000333'
const at = '2026-10-18T12:00:00.000Z'
const whoami = async () => ({
  user: { id: newRecordId() },
  activeSpaceId: space,
  personalSpaceId: space,
  memberships: [],
})

afterEach(() => {
  delete process.env.ORCH_RECORD_API_URL
  installRecordApiClient(createMemoryRecordApiClient())
})

test('hosted port failure is inert and success adopts the hosted identity', async () => {
  process.env.ORCH_RECORD_API_URL = 'https://record.example.test'
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    whoami,
    async writePort() {
      throw new Error('hosted doctrine failed')
    },
  })
  await expect(addDoctrineRule(991, 'Hosted', 'Hosted body.', at)).rejects.toThrow(
    'hosted doctrine failed',
  )
  expect(db().query('SELECT 1 FROM port_doctrine WHERE number=991').get()).toBeNull()

  const id = newRecordId()
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    whoami,
    async writePort() {
      return {
        doctrine: {
          id,
          spaceId: space,
          number: 991,
          title: 'Hosted',
          body: 'Hosted body.',
          createdAt: at,
          retiredAt: null,
          version: 1,
          updatedAt: at,
        },
      }
    },
  })
  await addDoctrineRule(991, 'Hosted', 'Hosted body.', at)
  expect(
    db().query('SELECT record_id FROM port_doctrine WHERE space_id=? AND number=991').get(space),
  ).toEqual({ record_id: id })
})

test('every hosted port writer refuses a worker before calling the record', () => {
  process.env.ORCH_RECORD_API_URL = 'https://record.example.test'
  const priorRunId = process.env.ORCH_RUN_ID
  process.env.ORCH_RUN_ID = 'port-writer-worker'
  let calls = 0
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    whoami,
    async writePort() {
      calls++
      throw new Error('writePort must not be called')
    },
  })
  const source = newRecordId()
  const target = newRecordId()
  const writers = [
    () => setBaselineForProjects(source, target, null),
    () => addSkip('01990000-0000-7000-8000-000000999999', 'candidate', 'reason'),
    () =>
      setLedgerRef({
        taskKey: 'DEV-1',
        targetProjectId: target,
        note: 'note',
        sources: [{ source_project_record_id: source, commits: [], paths: [], note: 'source' }],
      }),
    () => resolveLedgerRef(target, 'DEV-1'),
    () => removeLedgerRef(target, 'DEV-1'),
    () => addDoctrineRule(992, 'Worker', 'Worker body.', at),
    () => retireDoctrineRule(992, at),
  ]
  try {
    for (const write of writers) {
      expect(write).toThrow('refusing port store write from an orchestrator worker run')
    }
    expect(calls).toBe(0)
  } finally {
    if (priorRunId === undefined) delete process.env.ORCH_RUN_ID
    else process.env.ORCH_RUN_ID = priorRunId
  }
})
