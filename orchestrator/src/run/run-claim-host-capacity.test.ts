import { expect, test } from 'bun:test'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { clearMigrationDrain, setMigrationDrain } from '../database/migration-drain.ts'
import type { HostLoad } from '../gate-load.ts'
import { admitFreshRepositoryRun } from './run-claim-host-capacity.ts'

const available = (): HostLoad => ({
  gates: 0,
  loadavg: 0,
  cpuBusy: 0,
  ncpu: 8,
  freeMem: 8 * 1024 * 1024 * 1024,
  pressure: 'normal',
  swapUsed: 0,
  swapTotal: 0,
  swapGrowthBytesPerSec: null,
  recentAdmissions: 0,
  waitingRequests: 0,
  oldestWaitMs: 0,
})

const runningRun = () => addRun({ agent: 'codex', job: 'implement', status: 'running' })
const deps = { env: {}, platform: 'linux' as const, measure: available }

test('claim admission skips non-repository jobs without a decision', async () => {
  const runId = runningRun()
  await admitFreshRepositoryRun(db(), runId, false, false, deps)
  expect(db().query('SELECT host_admission FROM run WHERE record_id=?').get(runId)).toEqual({
    host_admission: null,
  })
})

test('claim admission skips an existing chain without a decision', async () => {
  const runId = runningRun()
  await admitFreshRepositoryRun(db(), runId, true, true, deps)
  expect(db().query('SELECT host_admission FROM run WHERE record_id=?').get(runId)).toEqual({
    host_admission: null,
  })
})

test('claim admission records a fresh repository run decision', async () => {
  const runId = runningRun()
  await admitFreshRepositoryRun(db(), runId, true, false, deps)
  const row = db().query('SELECT host_admission FROM run WHERE record_id=?').get(runId) as {
    host_admission: string
  }
  expect(JSON.parse(row.host_admission)).toMatchObject({ decision: 'admit' })
})

test('claim admission raises the migration-drain remedy', async () => {
  const runId = runningRun()
  setMigrationDrain(db(), '0199_test_drain')
  try {
    await expect(admitFreshRepositoryRun(db(), runId, true, false, deps)).rejects.toThrow(
      'run stopped for migration drain 0199_test_drain; re-dispatch after bottega machine update finishes',
    )
  } finally {
    clearMigrationDrain(db())
  }
})
