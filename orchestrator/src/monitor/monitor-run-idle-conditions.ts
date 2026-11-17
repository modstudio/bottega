// concern: monitor-run-idle-conditions
/** Owns idle and stalled run condition detection. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { pidAlive } from '../../../shared/process-identity.ts'
import { db } from '../database/db.ts'
import { capacityWaitSinceForRun, idleLabel, idleMsSince, idleWarnMs } from '../events.ts'
import { sampleProcesses } from '../process-resource-sampler.ts'
import { liveMemberStall, liveRunMembers } from '../run/live-run-member.ts'
import { isFreshAgentCapacityWait, isFreshRunHostWait } from '../run/run-liveness-policy.ts'
import { idleStallMs } from '../stalled-run.ts'
import type { MonitorCondition } from './monitor-types.ts'

export const age = (since: string | null, clock: number) => {
  if (!since) return null
  const at = Date.parse(since)
  return Number.isFinite(at) ? Math.max(0, clock - at) : null
}

export function elapsedDetail(elapsedMs: number | null): string {
  if (elapsedMs == null) return 'elapsed time unknown'
  if (elapsedMs < 60_000) return `elapsed ${Math.round(elapsedMs / 1000)}s`
  if (elapsedMs < 3_600_000) return `elapsed ${Math.round(elapsedMs / 60_000)}m`
  return `elapsed ${(elapsedMs / 3_600_000).toFixed(1)}h`
}

type IdleRunFacts = {
  record_id: string
  started_at: string
  last_event_at: string | null
  agent: string
  job: string
  session_id: string | null
  pidAlive: boolean | null
  pid?: number | null
  agent_pid?: number | null
  host_wait_since?: string | null
  capacity_wait_since?: string | null
}

/** Classify one running row from already-observed process and elapsed-time facts. */
export function idleRunCondition(
  run: IdleRunFacts,
  clock = Date.now(),
  threshold = idleWarnMs(),
): MonitorCondition | null {
  // A fresh host wait outranks stale-run; an agent wait ranks below it.
  if (isFreshRunHostWait('running', run.host_wait_since, clock)) return null
  if (run.pidAlive === false) {
    return {
      kind: 'stale-run',
      subject: `run:${run.record_id}`,
      since: run.started_at,
      ageMs: age(run.started_at, clock),
      detail: `run ${run.record_id} is running but its recorded pid is gone; no terminal state was recorded`,
      action: `run ${PLATFORM_SLUG} run stop ${run.record_id}`,
      ownerSession: run.session_id,
    }
  }
  if (run.host_wait_since) {
    const ageMs = age(run.host_wait_since, clock)
    const pid = run.pid == null ? 'none' : String(run.pid)
    return {
      kind: 'stuck-host-wait',
      subject: `run:${run.record_id}`,
      since: run.host_wait_since,
      ageMs,
      detail: `run ${run.record_id} host-capacity wait is stuck; wait age ${elapsedDetail(ageMs)}; coordinator pid ${pid}`,
      action: `check the coordinator pid named on the row; run ${PLATFORM_SLUG} run stop ${run.record_id} if it is dead`,
      ownerSession: run.session_id,
    }
  }
  if (isFreshAgentCapacityWait('running', run.capacity_wait_since, run.agent_pid, clock))
    return null
  const label = idleLabel(run.last_event_at, run.started_at, clock, threshold)
  if (!label) return null
  return {
    kind: 'idle',
    subject: `run:${run.record_id}`,
    since: run.last_event_at ?? run.started_at,
    ageMs: idleMsSince(run.last_event_at, run.started_at, clock),
    detail: `run ${run.record_id} ${run.agent}/${run.job} ${label}`,
    action: 'reported; the run coordinator checkpoints and terminates past the idle-kill threshold',
    ownerSession: run.session_id,
  }
}

/** Report live runs whose vendor stream has gone quiet. The coordinator, not the monitor, checkpoints and terminates past the idle-kill threshold. */
export function idleRunConditions(
  clock = Date.now(),
  database: Database = db(),
): MonitorCondition[] {
  const running = database
    .query(
      `SELECT record_id, started_at, last_event_at, agent, job, session_id, pid, agent_pid, host_wait_since
       FROM run WHERE status='running'`,
    )
    .all() as {
    record_id: string
    started_at: string
    last_event_at: string | null
    agent: string
    job: string
    session_id: string | null
    pid: number | null
    agent_pid: number | null
    host_wait_since: string | null
  }[]
  return running.flatMap((run): MonitorCondition[] => {
    const facts = { ...run, pidAlive: run.pid === null ? null : pidAlive(run.pid) }
    let condition = idleRunCondition(facts, clock)
    if (condition?.kind === 'idle') {
      condition = idleRunCondition(
        { ...facts, capacity_wait_since: capacityWaitSinceForRun(run.record_id) },
        clock,
      )
    }
    return condition ? [condition] : []
  })
}

/** Report silent, CPU-idle workers without changing their lifecycle. */
export function stalledRunConditions(
  clock = Date.now(),
  deps: {
    samples?: ReturnType<typeof sampleProcesses>
    observedStartTime?: (pid: number) => string | null
  } = {},
  database: Database = db(),
): MonitorCondition[] {
  const running = liveRunMembers(database)
  const samples = deps.samples ?? (running.length ? sampleProcesses() : [])
  return running.flatMap((run): MonitorCondition[] => {
    let observed = liveMemberStall(run, samples, clock, idleStallMs(), deps.observedStartTime)
    if (observed.state === 'stalled') {
      observed = liveMemberStall(
        { ...run, capacity_wait_since: capacityWaitSinceForRun(run.record_id) },
        samples,
        clock,
        idleStallMs(),
        deps.observedStartTime,
      )
    }
    if (observed.state !== 'stalled' || observed.idleMs === null || observed.detail === null)
      return []
    return [
      {
        kind: 'stalled-run',
        subject: `run:${run.record_id}`,
        since: run.last_event_at ?? run.started_at,
        ageMs: observed.idleMs,
        detail: observed.detail,
        action: `run ${PLATFORM_SLUG} run stop ${run.record_id}, then re-dispatch; otherwise wait for the idle bound`,
        ownerSession: run.session_id,
      },
    ]
  })
}
