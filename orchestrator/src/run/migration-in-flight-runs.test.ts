import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { PRELOAD_RUNS } from '../../test/preload.ts'
import { db } from '../database/db.ts'
import { applyMigrationsBefore } from '../database/migrations.ts'
import { fixtureProjectRecordId } from '../database/test-database.fixture.ts'
import { tryKernelLease } from '../project/project-lock.ts'
import {
  askingRowMayHoldOldSchema,
  formatMigrationInFlightRun,
  migrationInFlightRuns,
  migrationLeaseHoldingRuns,
} from './migration-in-flight-runs.ts'
import {
  acquireRunLease,
  heldRunLeaseIds,
  removeFreeRunCloseOutLease,
  removeFreeRunLease,
  runLeaseIds,
  withRunCloseOutLease,
} from './run-lease.ts'

test('asking rows wait for every process that may hold the old schema', () => {
  expect(
    askingRowMayHoldOldSchema({ hasLease: true, coordinatorAlive: false, agentIdentity: 'dead' }),
  ).toBe(true)
  expect(
    askingRowMayHoldOldSchema({ hasLease: false, coordinatorAlive: true, agentIdentity: 'dead' }),
  ).toBe(true)
  expect(
    askingRowMayHoldOldSchema({ hasLease: false, coordinatorAlive: false, agentIdentity: 'live' }),
  ).toBe(true)
  expect(
    askingRowMayHoldOldSchema({
      hasLease: false,
      coordinatorAlive: false,
      agentIdentity: 'unknown',
    }),
  ).toBe(true)
  expect(
    askingRowMayHoldOldSchema({ hasLease: false, coordinatorAlive: false, agentIdentity: 'dead' }),
  ).toBe(false)
  expect(
    askingRowMayHoldOldSchema({
      hasLease: false,
      coordinatorAlive: false,
      agentIdentity: 'reused',
    }),
  ).toBe(false)
})

test('lease reports shim a store from before run host waits', () => {
  const path = join(PRELOAD_RUNS, `pre-0139-${randomUUID()}.db`)
  const database = new Database(path, { create: true })
  const runId = randomUUID()
  const leasePath = join(PRELOAD_RUNS, 'leases', `${runId}.lock`)
  mkdirSync(join(PRELOAD_RUNS, 'leases'), { recursive: true })
  let lease: ReturnType<typeof tryKernelLease> = null
  try {
    applyMigrationsBefore(database, '0139_run_host_wait')
    database
      .query(
        `INSERT INTO run
         (record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,pid)
         VALUES (?,1,datetime('now'),'codex','old-store','sha',0,'','running',?)`,
      )
      .run(runId, process.pid)
    lease = tryKernelLease(leasePath, true)
    expect(lease).not.toBeNull()
    expect(migrationLeaseHoldingRuns(database)).toEqual([
      {
        name: runId,
        status: 'running',
        waiting: false,
        holderPid: process.pid,
        kind: 'run-lease',
      },
    ])
  } finally {
    lease?.release()
    try {
      unlinkSync(leasePath)
    } catch {
      // A failed assertion may precede lease-file creation.
    }
    database.close()
    try {
      unlinkSync(path)
    } catch {
      // SQLite may already have removed an unopened fixture.
    }
  }
})

test('a terminal run remains in flight while its coordinator is closing', async () => {
  const database = db()
  fixtureProjectRecordId(database)
  const runId = randomUUID()
  database
    .query(
      `INSERT INTO run
       (record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,pid,project_record_id)
       VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM run),datetime('now'),'codex','closing-fixture','sha',0,'','ok',?,
               (SELECT record_id FROM project ORDER BY name LIMIT 1))`,
    )
    .run(runId, process.pid)
  try {
    await withRunCloseOutLease(
      runId,
      () => {},
      async () => {
        expect(heldRunLeaseIds()).not.toContain(runId)
        expect(runLeaseIds()).not.toContain(runId)
        const closing = migrationInFlightRuns(database).find((run) => run.name === runId)
        expect(closing).toEqual({
          name: runId,
          status: 'ok',
          waiting: false,
          holderPid: process.pid,
          kind: 'close-out',
        })
        expect(formatMigrationInFlightRun(closing!)).toBe(
          `${runId} (ok, holder pid ${process.pid}, closing)`,
        )
      },
    )
    expect(migrationInFlightRuns(database).some((run) => run.name === runId)).toBe(false)
  } finally {
    removeFreeRunCloseOutLease(runId)
    database.query('DELETE FROM run WHERE record_id=?').run(runId)
  }
})

test('an asking row needs a live recorded process or a held lease', () => {
  const database = db()
  fixtureProjectRecordId(database)
  const runId = randomUUID()
  database
    .query(
      `INSERT INTO run
       (record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,pid,agent_pid,agent_start_time,project_record_id)
       VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM run),datetime('now'),'codex','asking-fixture','sha',0,'','asking',?,?,?,
               (SELECT record_id FROM project ORDER BY name LIMIT 1))`,
    )
    .run(runId, 4_200_000, 4_200_001, 'dead birth')
  expect(migrationInFlightRuns(database).some((run) => run.name === runId)).toBe(false)
  const lease = acquireRunLease(runId)
  try {
    expect(migrationInFlightRuns(database).find((run) => run.name === runId)).toEqual({
      name: runId,
      status: 'asking',
      waiting: false,
      holderPid: 4_200_001,
      kind: 'run-lease',
    })
  } finally {
    lease.release()
    removeFreeRunLease(runId)
  }
  // A live agent with no recorded start time is unknown, not dead, so it still holds the drain.
  database
    .query('UPDATE run SET agent_pid=?, agent_start_time=NULL WHERE record_id=?')
    .run(process.pid, runId)
  try {
    expect(migrationInFlightRuns(database).find((run) => run.name === runId)).toEqual({
      name: runId,
      status: 'asking',
      waiting: false,
      holderPid: process.pid,
      kind: 'row',
    })
  } finally {
    database.query('DELETE FROM run WHERE record_id=?').run(runId)
  }
})
