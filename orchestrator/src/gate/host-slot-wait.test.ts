import { expect, test } from 'bun:test'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import type { GateWaitState } from '../gate-load.ts'
import { hostSlotWaitCallbacks } from './host-slot-wait.ts'

test('a gate wait records the sampled CPU source and decision figures', () => {
  const runId = addRun({ agent: 'codex', job: 'implement', status: 'running' })
  const state: GateWaitState = {
    delayedMs: 250,
    heldOn: ['load'],
    load: {
      gates: 1,
      loadavg: 6,
      cpuBusy: 5,
      ncpu: 4,
      freeMem: 3 * 1024 * 1024 * 1024,
      pressure: 'warning',
      swapUsed: 10,
      swapTotal: 20,
      swapGrowthBytesPerSec: 30,
      recentAdmissions: 2,
      waitingRequests: 1,
      oldestWaitMs: 250,
    },
  }

  hostSlotWaitCallbacks({ runId, writeProgress: () => {} }).onWaitFinished(state)

  const row = db()
    .query<{ host_load: string }, [string]>(
      "SELECT host_load FROM contention WHERE run_record_id=? AND resource_key='host-capacity'",
    )
    .get(runId)!
  expect(JSON.parse(row.host_load)).toEqual({
    loadavg: 6,
    cpuBusy: 5,
    ncpu: 4,
    recentAdmissions: 2,
    freeMem: 3 * 1024 * 1024 * 1024,
    pressure: 'warning',
    swapGrowthBytesPerSec: 30,
    cpuBusySource: 'sampled',
  })
})
