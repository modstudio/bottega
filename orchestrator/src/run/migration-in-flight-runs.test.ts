import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { PRELOAD_RUNS } from '../../test/preload.ts'
import { applyMigrationsBefore } from '../database/migrations.ts'
import { tryKernelLease } from '../project/project-lock.ts'
import { migrationLeaseHoldingRuns } from './migration-in-flight-runs.ts'

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
