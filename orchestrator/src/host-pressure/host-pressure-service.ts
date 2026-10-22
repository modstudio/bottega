// concern: host-pressure sampling and persistence adapter
/** Observes once, stamps session ancestry, and persists bounded host-pressure samples. */

import type { Database } from 'bun:sqlite'
import { newRecordId } from '../../../shared/record-id.ts'
import { db, recordSessionSeen, sessionId, writeTransaction } from '../database/db.ts'
import { type HostLoad, measureHostLoad } from '../gate-load.ts'
import { processTableSnapshot } from '../resources/process-inventory.ts'
import {
  ancestorIdentityChain,
  nextSessionAncestorChain,
  type ProcessIdentity,
  type ProcessTreeSample,
  parseStoredAncestorChain,
} from '../resources/session-process-anchoring.ts'
import {
  HOST_PRESSURE_SAMPLE_INTERVAL_MS,
  HOST_PRESSURE_SAMPLE_RETENTION_MS,
  type PressureSample,
} from './host-pressure-decision.ts'

export type ProcessTableObservation = {
  processes: ProcessTreeSample[] | null
  error: string | null
  elapsedMs: number
  cpuMs: number
}

function observeProcessTable(): ProcessTableObservation {
  const startedAt = performance.now()
  const cpuStartedAt = process.cpuUsage()
  try {
    const observed = processTableSnapshot()
    const cpu = process.cpuUsage(cpuStartedAt)
    return {
      processes: observed.error
        ? null
        : observed.facts.map(({ pid, ppid, cpu, command, startTime }) => ({
            pid,
            ppid,
            cpu,
            command,
            startTime,
          })),
      error: observed.error ? `process table unavailable: ${observed.error}` : null,
      elapsedMs: performance.now() - startedAt,
      cpuMs: (cpu.user + cpu.system) / 1_000,
    }
  } catch (cause) {
    const cpu = process.cpuUsage(cpuStartedAt)
    return {
      processes: null,
      error: `process table unavailable: ${String(cause)}`,
      elapsedMs: performance.now() - startedAt,
      cpuMs: (cpu.user + cpu.system) / 1_000,
    }
  }
}

/** Machine-wide interval and retention are enforced in the same immediate transaction. */
export function sampleHostPressure(
  database: Database,
  load: HostLoad = measureHostLoad(),
  sampledAt = new Date().toISOString(),
  observed: ProcessTableObservation = observeProcessTable(),
): boolean {
  const sampledMs = Date.parse(sampledAt)
  return writeTransaction(() => {
    const latest = database
      .query('SELECT sampled_at FROM host_pressure_sample ORDER BY sampled_at DESC LIMIT 1')
      .get() as { sampled_at: string } | null
    if (latest && sampledMs - Date.parse(latest.sampled_at) < HOST_PRESSURE_SAMPLE_INTERVAL_MS)
      return false
    database
      .query(
        `INSERT INTO host_pressure_sample
         (record_id,sampled_at,loadavg,ncpu,memory_pressure,processes,process_error,
          observation_elapsed_ms,observation_cpu_ms)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        newRecordId(),
        sampledAt,
        load.loadavg,
        load.ncpu,
        load.pressure,
        observed.processes ? JSON.stringify(observed.processes) : null,
        observed.error,
        observed.elapsedMs,
        observed.cpuMs,
      )
    database
      .query('DELETE FROM host_pressure_sample WHERE sampled_at < ?')
      .run(new Date(sampledMs - HOST_PRESSURE_SAMPLE_RETENTION_MS).toISOString())
    return true
  }, database)
}

function sessionAncestorChain(
  observed: ProcessTableObservation,
  pid = process.pid,
): ProcessIdentity[] | undefined {
  return observed.processes ? ancestorIdentityChain(pid, observed.processes) : undefined
}

export function stampSessionProcessObservation(
  database: Database,
  sid: string | null,
  at: string,
  chain: ProcessIdentity[] | undefined,
): void {
  if (!sid || chain === undefined) {
    recordSessionSeen(sid, at, undefined, database)
    return
  }
  const stored = database
    .query('SELECT ancestor_chain FROM session_seen WHERE session_id=?')
    .get(sid) as { ancestor_chain: string | null } | null
  const previous = parseStoredAncestorChain(sid, stored?.ancestor_chain ?? null).chain
  recordSessionSeen(
    sid,
    at,
    { chain: nextSessionAncestorChain(previous, chain), confirmedAt: at },
    database,
  )
}

function parseProcesses(value: string | null): ProcessTreeSample[] | null {
  return value === null ? null : (JSON.parse(value) as ProcessTreeSample[])
}

export function loadHostPressureSamples(database: Database, clock: number): PressureSample[] {
  return (
    database
      .query(
        `SELECT sampled_at,loadavg,ncpu,memory_pressure,processes,
                observation_elapsed_ms,observation_cpu_ms
         FROM host_pressure_sample WHERE sampled_at >= ? ORDER BY sampled_at`,
      )
      .all(new Date(clock - HOST_PRESSURE_SAMPLE_RETENTION_MS).toISOString()) as {
      sampled_at: string
      loadavg: number
      ncpu: number
      memory_pressure: string
      processes: string | null
      observation_elapsed_ms: number
      observation_cpu_ms: number
    }[]
  ).map((row) => ({
    sampledAt: Date.parse(row.sampled_at),
    loadavg: row.loadavg,
    ncpu: row.ncpu,
    memoryPressure: row.memory_pressure,
    processes: parseProcesses(row.processes),
    observationElapsedMs: row.observation_elapsed_ms,
    observationCpuMs: row.observation_cpu_ms,
  }))
}

/** The CLI boundary calls one service; observation and advisory failure stay inside it. */
export function recordSessionHostPressure(database?: Database): void {
  const observed = observeProcessTable()
  const store = database ?? db()
  const observedAt = new Date().toISOString()
  try {
    stampSessionProcessObservation(
      store,
      sessionId(store),
      observedAt,
      sessionAncestorChain(observed),
    )
  } catch {
    // Session ancestry is advisory. It must not break the command being stamped.
  }
  try {
    sampleHostPressure(store, undefined, observedAt, observed)
  } catch {
    // Host sampling is advisory. It must not break the command that supplied the heartbeat.
  }
}
