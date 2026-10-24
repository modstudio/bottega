import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { PRELOAD_RUNS } from '../../test/preload.ts'
import { db } from '../database/db.ts'
import { applyMigrationsBefore } from '../database/migrations.ts'
import { tryKernelLease } from '../project/project-lock.ts'
import {
  formatMigrationInFlightRun,
  migrationInFlightRuns,
  migrationLeaseHoldingRuns,
} from './migration-in-flight-runs.ts'
import {
  acquireRunCloseOutLease,
  heldRunLeaseIds,
  removeFreeRunCloseOutLease,
  runLeaseIds,
} from './run-lease.ts'

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
        leaseHolding: true,
        closing: false,
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

test('a terminal run remains in flight while its coordinator is closing', () => {
  const database = db()
  const runId = randomUUID()
  database
    .query(
      `INSERT INTO run
       (record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,pid)
       VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM run),datetime('now'),'codex','closing-fixture','sha',0,'','ok',?)`,
    )
    .run(runId, process.pid)
  const lease = acquireRunCloseOutLease(runId)
  try {
    expect(heldRunLeaseIds()).not.toContain(runId)
    expect(runLeaseIds()).not.toContain(runId)
    const closing = migrationInFlightRuns(database).find((run) => run.name === runId)
    expect(closing).toEqual({
      name: runId,
      status: 'ok',
      waiting: false,
      holderPid: process.pid,
      leaseHolding: false,
      closing: true,
    })
    expect(formatMigrationInFlightRun(closing!)).toBe(`${runId} (ok, closing)`)
    lease.release()
    expect(migrationInFlightRuns(database).some((run) => run.name === runId)).toBe(false)
  } finally {
    lease.release()
    removeFreeRunCloseOutLease(runId)
    database.query('DELETE FROM run WHERE record_id=?').run(runId)
  }
})
