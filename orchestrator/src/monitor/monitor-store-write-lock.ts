// concern: monitor
/** Resolves a sampled database writer to process and run identity using read-only work. */

import { processCommandLine } from '../../../shared/process-identity.ts'
import { sampleWalWriteLock } from '../../../shared/store-write-lock.ts'
import { DB_PATH, openReadOnlyDatabase } from '../database/db.ts'

export type StoreWriteLockReport =
  | {
      supported: true
      kind: 'store-write-lock-free' | 'store-write-lock-held'
      store: string
      classification: 'free' | 'contended' | 'held'
      sampleCount: number
      pid: number | null
      command: string | null
      runId: string | null
      isRunSupervisor: boolean
    }
  | {
      supported: false
      kind: 'store-write-lock-probe-unsupported'
      store: string
      reason: string
      sampleCount: number
    }

function supervisedRun(storePath: string, pid: number): string | null {
  const database = openReadOnlyDatabase(storePath)
  try {
    const row = database
      .query<{ record_id: string }, [number]>(
        "SELECT record_id FROM run WHERE pid=? AND status IN ('running','asking') ORDER BY number DESC LIMIT 1",
      )
      .get(pid)
    return row?.record_id ?? null
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
    command: pid === null ? null : processCommandLine(pid),
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
    `run ${report.runId ?? 'none'}; orchestrator run supervisor ${report.isRunSupervisor ? 'yes' : 'no'}`
  )
}
