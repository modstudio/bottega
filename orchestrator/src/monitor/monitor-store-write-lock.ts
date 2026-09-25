// concern: monitor
/** Resolves a sampled database writer to process and run identity using read-only work. */

import { DB_PATH, openReadOnlyDatabase } from '../database/db.ts'
import { sampleWalWriteLock } from '../database/store-write-lock.ts'

export type StoreWriteLockReport =
  | {
      supported: true
      kind: 'store-write-lock-free' | 'store-write-lock-held'
      store: string
      classification: 'free' | 'contended' | 'held'
      sampleCount: number
      pid: number | null
      command: string | null
      runId: number | null
      isRunSupervisor: boolean
    }
  | {
      supported: false
      kind: 'store-write-lock-probe-unsupported'
      store: string
      reason: string
      sampleCount: number
    }

function holderCommand(pid: number): string | null {
  const result = Bun.spawnSync(['/bin/ps', '-p', String(pid), '-o', 'command='], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) return null
  return new TextDecoder().decode(result.stdout).trim() || null
}

function supervisedRun(storePath: string, pid: number): number | null {
  const database = openReadOnlyDatabase(storePath)
  try {
    const row = database
      .query<{ id: number }, [number]>(
        "SELECT id FROM run WHERE pid=? AND status IN ('running','asking') ORDER BY id DESC LIMIT 1",
      )
      .get(pid)
    return row?.id ?? null
  } finally {
    database.close()
  }
}

export async function storeWriteLockReport(storePath = DB_PATH): Promise<StoreWriteLockReport> {
  const sampled = await sampleWalWriteLock(storePath)
  if (!sampled.supported) {
    return {
      supported: false,
      kind: 'store-write-lock-probe-unsupported',
      store: storePath,
      reason: sampled.reason,
      sampleCount: sampled.sampleCount,
    }
  }
  const pid = sampled.holderPid
  const runId = pid === null ? null : supervisedRun(storePath, pid)
  return {
    supported: true,
    kind: pid === null ? 'store-write-lock-free' : 'store-write-lock-held',
    store: storePath,
    classification: sampled.classification,
    sampleCount: sampled.sampleCount,
    pid,
    command: pid === null ? null : holderCommand(pid),
    runId,
    isRunSupervisor: runId !== null,
  }
}

export function formatStoreWriteLockReport(report: StoreWriteLockReport): string {
  if (!report.supported) return `${report.kind}: ${report.reason}`
  if (report.pid === null) {
    return `${report.kind}: ${report.classification} after ${report.sampleCount} samples`
  }
  return (
    `${report.kind}: ${report.classification} after ${report.sampleCount} samples; ` +
    `pid ${report.pid}; command ${report.command ?? 'unavailable'}; ` +
    `run ${report.runId ?? 'none'}; orch run supervisor ${report.isRunSupervisor ? 'yes' : 'no'}`
  )
}
