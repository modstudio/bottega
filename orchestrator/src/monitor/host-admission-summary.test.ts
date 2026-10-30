import { expect, test } from 'bun:test'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import type { RunHostAdmission } from '../run/run-host-capacity.ts'
import {
  HOST_ADMISSION_MONITOR_WINDOW_MS,
  hostAdmissionSummary,
  summarizeHostAdmissions,
} from './host-admission-summary.ts'

const admission = (
  at: number,
  decision: RunHostAdmission['decision'],
  loadavg: number,
  cpuBusy: number | null,
  pressure: RunHostAdmission['sample']['pressure'],
): RunHostAdmission => ({
  at: new Date(at).toISOString(),
  decision,
  heldOn: decision === 'hold' ? ['load'] : [],
  boundReached: false,
  waitedMs: 0,
  sample: {
    loadavg,
    cpuBusy,
    ncpu: 8,
    recentAdmissions: 0,
    heldWork: 1,
    pressure,
    swapUsed: 0,
    swapTotal: 0,
    swapGrowthBytesPerSec: null,
    freeMem: 1,
  },
})

test('the adapter selects only admissions inside the named window', () => {
  const now = Date.parse('2026-10-30T12:00:00.000Z')
  const recent = admission(now - 1_000, 'admit', 4, 3, 'normal')
  const oldRun = addRun({ agent: 'codex', job: 'implement' })
  const recentRun = addRun({ agent: 'codex', job: 'implement' })
  db()
    .query('UPDATE run SET host_admission_first=?,host_admission=? WHERE record_id=?')
    .run(
      '{"old":"unparsed"}',
      JSON.stringify(admission(now - 3_600_001, 'admit', 8, 7, 'warning')),
      oldRun,
    )
  db()
    .query('UPDATE run SET host_admission_first=?,host_admission=? WHERE record_id=?')
    .run(JSON.stringify(recent), JSON.stringify(recent), recentRun)

  expect(hostAdmissionSummary(db(), now)).toMatchObject({
    admitted: 1,
    held: 0,
    highestLoadavg: 4,
    highestCpuBusy: 3,
    pressures: ['normal'],
  })
})

test('summarizes recent first holds and admitting-decision host pressure', () => {
  const now = Date.parse('2026-10-30T12:00:00.000Z')
  const held = admission(now - 2_000, 'hold', 2, null, 'warning')
  const admittedAfterHold = admission(now - 1_000, 'admit', 6, 5, 'critical')
  const immediate = admission(now - 500, 'admit', 4, 3, 'normal')
  const old = admission(now - HOST_ADMISSION_MONITOR_WINDOW_MS - 1, 'admit', 20, 20, 'unknown')

  expect(
    summarizeHostAdmissions(
      [
        { first: held, admitted: admittedAfterHold },
        { first: immediate, admitted: immediate },
        { first: old, admitted: old },
      ],
      now,
    ),
  ).toEqual({
    windowMs: HOST_ADMISSION_MONITOR_WINDOW_MS,
    admitted: 2,
    held: 1,
    highestLoadavg: 6,
    highestCpuBusy: 5,
    pressures: ['critical', 'normal'],
  })
})
