// concern: host-pressure sampling and persistence adapter
/** Samples the process table once, persists bounded observations, and adapts pure decisions. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { newRecordId } from '../../shared/record-id.ts'
import { writeTransaction } from './database/db.ts'
import { type HostLoad, measureHostLoad } from './gate-load.ts'
import { decideHostPressure, type PressureSample } from './host-pressure-decision.ts'
import type { MonitorCondition } from './monitor/monitor-types.ts'
import {
  ancestorChain,
  type ProcessSample,
  parseProcessTable,
  sessionAnchors,
} from './process-tree.ts'

const HOST_PRESSURE_SAMPLE_INTERVAL_MS = 30_000
const HOST_PRESSURE_SAMPLE_RETENTION_MS = 15 * 60 * 1000
const PROCESS_TABLE_TIMEOUT_MS = 1_000

export type ProcessTableObservation = {
  processes: ProcessSample[] | null
  error: string | null
}

export function observeProcessTable(): ProcessTableObservation {
  try {
    const result = Bun.spawnSync(['/bin/ps', '-axo', 'pid=,ppid=,%cpu=,command='], {
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: PROCESS_TABLE_TIMEOUT_MS,
    })
    if (result.exitCode !== 0)
      return {
        processes: null,
        error: `process table unavailable: ps exited ${result.exitCode}: ${result.stderr.toString().trim() || 'no diagnostic'}`,
      }
    return { processes: parseProcessTable(result.stdout.toString()), error: null }
  } catch (cause) {
    return { processes: null, error: `process table unavailable: ${String(cause)}` }
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
         (record_id,sampled_at,loadavg,ncpu,pressure,processes,process_error)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
        newRecordId(),
        sampledAt,
        load.loadavg,
        load.ncpu,
        load.pressure,
        observed.processes ? JSON.stringify(observed.processes) : null,
        observed.error,
      )
    database
      .query('DELETE FROM host_pressure_sample WHERE sampled_at < ?')
      .run(new Date(sampledMs - HOST_PRESSURE_SAMPLE_RETENTION_MS).toISOString())
    return true
  }, database)
}

export function sessionAncestorPids(
  observed: ProcessTableObservation,
  pid = process.pid,
): number[] | undefined {
  return observed.processes ? ancestorChain(pid, observed.processes) : undefined
}

function parseProcesses(value: string | null): ProcessSample[] | null {
  if (value === null) return null
  const parsed = JSON.parse(value) as ProcessSample[]
  return parsed
}

function loadSamples(database: Database, clock: number): PressureSample[] {
  return (
    database
      .query(
        `SELECT sampled_at,loadavg,ncpu,processes FROM host_pressure_sample
         WHERE sampled_at >= ? ORDER BY sampled_at`,
      )
      .all(new Date(clock - HOST_PRESSURE_SAMPLE_RETENTION_MS).toISOString()) as {
      sampled_at: string
      loadavg: number
      ncpu: number
      processes: string | null
    }[]
  ).map((row) => ({
    sampledAt: Date.parse(row.sampled_at),
    loadavg: row.loadavg,
    ncpu: row.ncpu,
    processes: parseProcesses(row.processes),
  }))
}

function compactProcesses(processes: ProcessSample[]): string {
  return [...processes]
    .sort((a, b) => b.cpu - a.cpu)
    .slice(0, 8)
    .map((process) => `${process.pid} ${process.command}`)
    .join('; ')
}

/** Build monitor conditions from persisted facts; the pure module owns the attribution ruling. */
export function hostPressureConditions(database: Database, clock = Date.now()): MonitorCondition[] {
  const liveSince = new Date(clock - 60 * 60 * 1000).toISOString()
  const chains = (
    database
      .query(
        `SELECT session_id,ancestor_pids FROM session_seen
         WHERE last_seen >= ? AND ancestor_pids IS NOT NULL`,
      )
      .all(liveSince) as { session_id: string; ancestor_pids: string }[]
  ).flatMap((row) => {
    const chain = JSON.parse(row.ancestor_pids) as unknown
    return Array.isArray(chain) && chain.every((pid) => Number.isInteger(pid))
      ? [{ sessionId: row.session_id, chain: chain as number[] }]
      : []
  })
  const runRows = database
    .query(
      `SELECT record_id,number,agent_pid,host_wait_since FROM run
       WHERE status IN ('running','asking')`,
    )
    .all() as {
    record_id: string
    number: number
    agent_pid: number | null
    host_wait_since: string | null
  }[]
  const waiting = runRows
    .filter((run) => run.host_wait_since !== null)
    .map((run) => `run ${run.number} (${run.record_id})`)
  const samples = loadSamples(database, clock)
  const latestStored = database
    .query(
      `SELECT sampled_at,process_error FROM host_pressure_sample
       ORDER BY sampled_at DESC LIMIT 1`,
    )
    .get() as { sampled_at: string; process_error: string | null } | null
  if (latestStored?.process_error)
    return [
      {
        kind: 'observation-error',
        subject: `host-process-table:${latestStored.sampled_at}`,
        since: latestStored.sampled_at,
        ageMs: clock - Date.parse(latestStored.sampled_at),
        detail: latestStored.process_error,
        action: `restore permission to run /bin/ps and read the process table, then run ${PLATFORM_SLUG} machine monitor; no host-pressure attribution was inferred`,
      },
    ]
  const attributions = decideHostPressure({
    samples,
    anchors: sessionAnchors(chains),
    liveRunPids: runRows.flatMap((run) => (run.agent_pid ? [run.agent_pid] : [])),
  })
  return attributions.map((attribution): MonitorCondition => {
    const subject = attribution.ownerSession
      ? `session:${attribution.ownerSession}`
      : `process:${attribution.rootPid}`
    const prior = database
      .query(
        `SELECT delivered_at FROM monitor_condition
         WHERE kind='host-pressure' AND subject=? AND condition_since=?
           AND delivered_at IS NOT NULL ORDER BY id DESC LIMIT 1`,
      )
      .get(subject, new Date(attribution.episodeStartedAt).toISOString()) as {
      delivered_at: string
    } | null
    const after = prior
      ? samples.filter((sample) => sample.sampledAt > Date.parse(prior.delivered_at))
      : []
    const delivery = prior
      ? ` Notice delivered to ${attribution.ownerSession} at ${prior.delivered_at}; load after delivery: ${after.length ? after.map((sample) => `${sample.loadavg.toFixed(2)}/${sample.ncpu}`).join(', ') : 'no later sample yet'}.`
      : attribution.ownerSession
        ? ` Notice pending for ${attribution.ownerSession}.`
        : ' No owning session was found; operator action is required.'
    const condition = {
      kind: 'host-pressure' as const,
      subject,
      since: new Date(attribution.episodeStartedAt).toISOString(),
      ageMs: clock - attribution.episodeStartedAt,
      detail: `PIDs and commands: ${compactProcesses(attribution.processes)}. Session CPU share ${(attribution.share * 100).toFixed(1)}% (${attribution.cpu.toFixed(1)}% CPU); load ${attribution.loadavg.toFixed(2)}/${attribution.ncpu} cores; waiting for host capacity: ${waiting.join(', ') || 'none'}.${delivery}`,
      action: `serialize CPU-heavy work, cap OMP_NUM_THREADS/MKL_NUM_THREADS/OPENBLAS_NUM_THREADS, or use nice; then run ${PLATFORM_SLUG} machine monitor`,
    }
    return attribution.ownerSession
      ? { ...condition, ownerSession: attribution.ownerSession }
      : condition
  })
}
