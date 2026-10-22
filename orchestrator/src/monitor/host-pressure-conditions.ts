// concern: host-pressure monitor conditions and reporting
/** Adapts persisted pressure facts into notices and the human monitor summary. */

import type { Database } from 'bun:sqlite'
import { basename } from 'node:path'
import { PLATFORM_NAME, PLATFORM_SLUG } from '../../../shared/brand.ts'
import { SESSION_LIVE_MS } from '../database/db.ts'
import {
  attributeProcessTrees,
  decideHostPressure,
  type LiveRunAnchor,
  type SessionAnchor,
} from '../host-pressure/host-pressure-decision.ts'
import { loadHostPressureSamples } from '../host-pressure/host-pressure-service.ts'
import { parseStoredAncestorChain, sessionAnchors } from '../resources/session-process-anchoring.ts'
import type {
  HostPressureConditionDetail,
  MonitorCondition,
  MonitorHostPressure,
} from './monitor-types.ts'

const MONITOR_HOST_PRESSURE_ATTRIBUTION_LIMIT = 5

function compactProcesses(processes: { pid: number; cpu: number; command: string }[]): string {
  return [...processes]
    .sort((a, b) => b.cpu - a.cpu)
    .slice(0, 8)
    .map((process) => `${process.pid} ${process.command}`)
    .join('; ')
}

function commandName(command: string): string {
  return basename(command.trim().split(/\s+/, 1)[0] ?? command) || 'unknown'
}

function sessionProjectRows(database: Database): Map<string, string> {
  return new Map(
    (
      database.query('SELECT session_id,project FROM presence').all() as {
        session_id: string
        project: string
      }[]
    ).map((row) => [row.session_id, row.project]),
  )
}

function pressureOwners(
  database: Database,
  clock: number,
): {
  sessions: SessionAnchor[]
  runs: LiveRunAnchor[]
  waiting: string[]
  errors: { sessionId: string; detail: string }[]
} {
  const liveSince = new Date(clock - SESSION_LIVE_MS).toISOString()
  const chains = (
    database
      .query(
        `SELECT session_id,ancestor_chain FROM session_seen
         WHERE last_seen >= ? AND ancestor_confirmed_at >= ? AND ancestor_chain IS NOT NULL`,
      )
      .all(liveSince, liveSince) as { session_id: string; ancestor_chain: string }[]
  ).map((row) => ({ row, parsed: parseStoredAncestorChain(row.session_id, row.ancestor_chain) }))
  const chainErrors = chains.flatMap(({ row, parsed }) =>
    parsed.error ? [{ sessionId: row.session_id, detail: parsed.error }] : [],
  )
  const validChains = chains.flatMap(({ row, parsed }) =>
    parsed.chain ? [{ sessionId: row.session_id, chain: parsed.chain }] : [],
  )
  const projects = sessionProjectRows(database)
  const sessions = [...sessionAnchors(validChains)].map(([sessionId, anchor]) => ({
    sessionId,
    pid: anchor.pid,
    startTime: anchor.startTime,
    project: projects.get(sessionId) ?? null,
  }))
  const runRows = database
    .query(
      `SELECT record_id,number,agent_pid,agent_start_time,host_wait_since,repo FROM run
       WHERE status IN ('running','asking')`,
    )
    .all() as {
    record_id: string
    number: number
    agent_pid: number | null
    agent_start_time: string | null
    host_wait_since: string | null
    repo: string | null
  }[]
  return {
    sessions,
    runs: runRows.flatMap((run) =>
      run.agent_pid && run.agent_start_time
        ? [
            {
              number: run.number,
              pid: run.agent_pid,
              startTime: run.agent_start_time,
              project: run.repo ?? 'unknown project',
            },
          ]
        : [],
    ),
    waiting: runRows
      .filter((run) => run.host_wait_since !== null)
      .map((run) => `run ${run.number} (${run.record_id})`),
    errors: chainErrors,
  }
}

function renderHostPressureConditionDetail(
  database: Database,
  detail: HostPressureConditionDetail,
  deliveredAt: string | null = null,
): string {
  const project = detail.project ? ` in project ${detail.project}` : ''
  const pendingOrDelivered = deliveredAt
    ? (() => {
        const after = database
          .query(
            `SELECT loadavg,ncpu FROM host_pressure_sample
             WHERE sampled_at > ? ORDER BY sampled_at`,
          )
          .all(deliveredAt) as { loadavg: number; ncpu: number }[]
        return `Notice delivered to ${detail.ownerSession} at ${deliveredAt}; load after delivery: ${after.length ? after.map((sample) => `${sample.loadavg.toFixed(2)}/${sample.ncpu}`).join(', ') : 'no later sample yet'}.`
      })()
    : detail.ownerSession
      ? `Notice pending for ${detail.ownerSession}.`
      : 'No owning session was found; operator action is required.'
  return `PIDs and commands: ${compactProcesses(detail.processes)}. ${detail.ownerName}${project} CPU share ${(detail.share * 100).toFixed(1)}% (${detail.cpu.toFixed(1)}% CPU); load ${detail.loadavg.toFixed(2)}/${detail.ncpu} cores; waiting for host capacity: ${detail.waiting.join(', ') || 'none'}. ${pendingOrDelivered}`
}

export function persistedHostPressureDetail(
  database: Database,
  condition: MonitorCondition,
  deliveredAt: string | null,
): string {
  return condition.kind === 'host-pressure' && condition.hostPressureDetail
    ? renderHostPressureConditionDetail(database, condition.hostPressureDetail, deliveredAt)
    : condition.detail
}

export function hostPressureObservation(
  database: Database,
  clock = Date.now(),
): { conditions: MonitorCondition[]; report: MonitorHostPressure } {
  const samples = loadHostPressureSamples(database, clock)
  const latest = samples.at(-1)
  const owners = pressureOwners(database, clock)
  const chainErrorConditions: MonitorCondition[] = owners.errors.map((error) => ({
    kind: 'observation-error',
    subject: `session-process-chain:${error.sessionId}`,
    since: null,
    ageMs: null,
    detail: error.detail,
    action: `record a fresh successful process observation for session ${error.sessionId}; no ownership was inferred from the invalid row`,
  }))
  const averages = samples.length
    ? {
        elapsedMs:
          samples.reduce((sum, sample) => sum + sample.observationElapsedMs, 0) / samples.length,
        cpuMs: samples.reduce((sum, sample) => sum + sample.observationCpuMs, 0) / samples.length,
      }
    : null
  const report: MonitorHostPressure = {
    available: Boolean(latest?.processes),
    error: latest?.processes === null ? 'latest process table unavailable' : null,
    memoryPressure: latest?.memoryPressure ?? null,
    attributions: latest
      ? attributeProcessTrees(latest, owners.sessions, owners.runs)
          .slice(0, MONITOR_HOST_PRESSURE_ATTRIBUTION_LIMIT)
          .map((attribution) => ({
            owner:
              attribution.owner.kind === 'outside'
                ? `outside ${PLATFORM_NAME}:${commandName(attribution.owner.name)}`
                : attribution.owner.name,
            project: attribution.owner.project,
            cpu: attribution.cpu,
            share: attribution.share,
          }))
      : [],
    averageObservationElapsedMs: averages?.elapsedMs ?? null,
    averageObservationCpuMs: averages?.cpuMs ?? null,
  }
  const latestStored = database
    .query(
      `SELECT sampled_at,process_error FROM host_pressure_sample
       ORDER BY sampled_at DESC LIMIT 1`,
    )
    .get() as { sampled_at: string; process_error: string | null } | null
  if (latestStored?.process_error)
    return {
      report: { ...report, error: latestStored.process_error },
      conditions: [
        ...chainErrorConditions,
        {
          kind: 'observation-error',
          subject: `host-process-table:${latestStored.sampled_at}`,
          since: latestStored.sampled_at,
          ageMs: clock - Date.parse(latestStored.sampled_at),
          detail: latestStored.process_error,
          action: `restore permission to run ps and read the process table, then run ${PLATFORM_SLUG} machine monitor; no host-pressure attribution was inferred`,
        },
      ],
    }
  const conditions = decideHostPressure({
    samples,
    sessions: owners.sessions,
    runs: owners.runs,
  }).map((attribution): MonitorCondition => {
    const ownerSession = attribution.owner.kind === 'session' ? attribution.owner.sessionId : null
    const subject = ownerSession
      ? `session:${ownerSession}`
      : `process:${commandName(attribution.rootCommand)}`
    const ownerName = ownerSession ? `Session ${ownerSession}` : 'Process tree'
    const hostPressureDetail: HostPressureConditionDetail = {
      processes: attribution.processes,
      ownerName,
      project: attribution.owner.project,
      share: attribution.share,
      cpu: attribution.cpu,
      loadavg: attribution.loadavg,
      ncpu: attribution.ncpu,
      waiting: owners.waiting,
      ownerSession,
    }
    const condition = {
      kind: 'host-pressure' as const,
      subject,
      since: new Date(attribution.episodeStartedAt).toISOString(),
      ageMs: clock - attribution.episodeStartedAt,
      detail: renderHostPressureConditionDetail(database, hostPressureDetail),
      action: `serialize CPU-heavy work, cap OMP_NUM_THREADS/MKL_NUM_THREADS/OPENBLAS_NUM_THREADS, or use nice; then run ${PLATFORM_SLUG} machine monitor`,
      hostPressureDetail,
    }
    return ownerSession ? { ...condition, ownerSession } : condition
  })
  return { conditions: [...chainErrorConditions, ...conditions], report }
}
