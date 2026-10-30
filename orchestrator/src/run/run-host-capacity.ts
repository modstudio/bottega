// concern: run host-capacity admission
/** Knows the repository-run host wait adapter. Must not know transports or routing. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { nowIso, tryWriteContention, writeTransaction } from '../database/db.ts'
import { activeMigrationDrain } from '../database/migration-drain-state.ts'
import { recordRunWarning } from '../events.ts'
import {
  CAPACITY_SAMPLE_MIN_WINDOW_MS,
  decideHostCapacityAdmission,
  HOST_LOAD_RESERVATION_MS,
  type HostCapacityDecision,
  type HostHoldCondition,
  type HostLoad,
  measureHostLoad,
  type RecordedHostLoad,
  recordedHostLoad,
} from '../gate-load.ts'
import { activeCores, HOST_RESERVATION_EVIDENCE_DAYS, reservedCores } from './host-reservation.ts'
import { TERMINAL_RUN_STATUS_SQL } from './run-status.ts'

export const RUN_HOST_WAIT_MAX_MS = 15 * 60_000
export const RUN_HOST_WAIT_POLL_MS = 1_000
const RUN_HOST_WAIT_POLL_CAP_MS = 15_000
const RUN_HOST_WAIT_POLL_JITTER_FRACTION = 0.2

type RunCapacityPoll = { baseMs: number; delayMs: number }

export function nextRunCapacityPoll(
  previousPollMs: number | undefined,
  random: number,
): RunCapacityPoll {
  if (previousPollMs === undefined)
    return { baseMs: RUN_HOST_WAIT_POLL_MS, delayMs: RUN_HOST_WAIT_POLL_MS }
  const baseMs = Math.min(previousPollMs * 2, RUN_HOST_WAIT_POLL_CAP_MS)
  const jitter = (random * 2 - 1) * RUN_HOST_WAIT_POLL_JITTER_FRACTION
  return { baseMs, delayMs: Math.round(baseMs * (1 + jitter)) }
}

export function isFreshRunHostWait(
  status: string,
  since: string | null | undefined,
  now = Date.now(),
): boolean {
  if (status !== 'running' || !since) return false
  const started = Date.parse(since)
  return Number.isFinite(started) && now - started <= RUN_HOST_WAIT_MAX_MS + RUN_HOST_WAIT_POLL_MS
}

type RunningRepositoryFacts = {
  running: number
  recentReservedCores: number
  hasOlderWaiter: boolean
}

type RunHostCapacityWaiter = {
  record_id: string
  host_wait_since: string
}

export const RUN_HOST_CAPACITY_WAITERS_SQL = `SELECT record_id, host_wait_since FROM run
        WHERE status='running' AND host_wait_since IS NOT NULL
        ORDER BY host_wait_since ASC, record_id ASC`

export const RUNNING_REPOSITORY_FACTS_SQL = `SELECT record_id FROM run
        WHERE status='running' AND host_wait_since IS NULL AND record_id<>? AND
              (worktree IS NOT NULL OR host_admission IS NOT NULL)`

const RUN_HOST_RESERVATIONS_SQL = `SELECT record_id, agent, agent_start_time, host_admission FROM run
        WHERE status='running' AND record_id<>? AND
              (host_admission IS NOT NULL OR
               (worktree IS NOT NULL AND host_wait_since IS NULL AND agent_start_time IS NOT NULL))`

export const RUN_HOST_RESERVATION_SAMPLES_SQL = `SELECT agent, started_at, latency_ms, agent_start_time, resource_cpu_ms
        FROM run
        WHERE status IN ${TERMINAL_RUN_STATUS_SQL}
          AND started_at>=? AND resource_cpu_ms IS NOT NULL AND latency_ms>0
          AND agent_start_time IS NOT NULL
          AND COALESCE(probe,0)=0 AND evidence_excluded IS NULL
          AND agent IN (SELECT value FROM json_each(?))`

/** Admission's FIFO waiter set: running repository rows still waiting on host capacity. */
function runHostCapacityWaiters(database: Database): RunHostCapacityWaiter[] {
  return database.query(RUN_HOST_CAPACITY_WAITERS_SQL).all() as RunHostCapacityWaiter[]
}

function runningRepositoryFacts(
  database: Database,
  runId: string,
  now: number,
  samplesByAgent: Map<string, number[]>,
): RunningRepositoryFacts {
  const rows = database.query(RUNNING_REPOSITORY_FACTS_SQL).all(runId) as { record_id: string }[]
  const reservations = database.query(RUN_HOST_RESERVATIONS_SQL).all(runId) as {
    record_id: string
    agent: string
    agent_start_time: string | null
    host_admission: string | null
  }[]
  const recentRows = reservations.filter((row) => {
    const admission = row.host_admission ? (JSON.parse(row.host_admission) as { at: string }) : null
    const admittedAt = Date.parse(admission?.at ?? row.agent_start_time ?? '')
    return Number.isFinite(admittedAt) && now - admittedAt < HOST_LOAD_RESERVATION_MS
  })
  const agents = [...new Set(recentRows.map((row) => row.agent))]
  const missingAgents = agents.filter((agent) => !samplesByAgent.has(agent))
  if (missingAgents.length) {
    const evidenceSince = new Date(
      now - HOST_RESERVATION_EVIDENCE_DAYS * 24 * 60 * 60_000,
    ).toISOString()
    const samples = database
      .query(RUN_HOST_RESERVATION_SAMPLES_SQL)
      .all(evidenceSince, JSON.stringify(missingAgents)) as {
      agent: string
      started_at: string
      latency_ms: number
      agent_start_time: string
      resource_cpu_ms: number
    }[]
    for (const agent of missingAgents) samplesByAgent.set(agent, [])
    for (const sample of samples) {
      const cores = activeCores({
        startedAt: sample.started_at,
        latencyMs: sample.latency_ms,
        agentStartTime: sample.agent_start_time,
        resourceCpuMs: sample.resource_cpu_ms,
      })
      if (cores !== null) samplesByAgent.get(sample.agent)!.push(cores)
    }
  }
  return {
    running: rows.length,
    recentReservedCores: recentRows.reduce(
      (total, row) => total + reservedCores(samplesByAgent.get(row.agent) ?? []),
      0,
    ),
    hasOlderWaiter:
      runHostCapacityWaiters(database).findIndex((waiter) => waiter.record_id === runId) > 0,
  }
}

function runIsRunning(database: Database, runId: string): boolean {
  const row = database.query('SELECT status FROM run WHERE record_id=?').get(runId) as {
    status: string
  } | null
  return row?.status === 'running'
}

function capacityDecision(input: {
  database: Database
  runId: string
  at: number
  started: number
  platform: NodeJS.Platform
  load: HostLoad
  samplesByAgent: Map<string, number[]>
}) {
  const repositories = runningRepositoryFacts(
    input.database,
    input.runId,
    input.at,
    input.samplesByAgent,
  )
  const load = input.load
  const recentAdmissions = load.recentAdmissions + repositories.recentReservedCores
  const decision = decideHostCapacityAdmission({
    heldWork: repositories.running,
    loadavg: load.loadavg,
    cpuBusy: load.cpuBusy,
    ncpu: load.ncpu,
    recentAdmissions,
    freeMem: load.freeMem,
    pressure: load.pressure,
    swapGrowthBytesPerSec: load.swapGrowthBytesPerSec,
    limit: null,
    platform: input.platform,
    waitedMs: input.at - input.started,
    maxWaitMs: RUN_HOST_WAIT_MAX_MS,
    hasOlderWaiter: repositories.hasOlderWaiter,
  })
  return {
    decision,
    load,
    reservedCores: repositories.recentReservedCores,
    admissionFacts: { heldWork: repositories.running, recentAdmissions },
  }
}

export type RunHostAdmission = {
  at: string
  decision: 'admit' | 'hold'
  heldOn: HostHoldCondition[]
  boundReached: boolean
  waitedMs: number
  sample: {
    loadavg: number
    cpuBusy: number | null
    ncpu: number
    recentAdmissions: number
    heldWork: number
    pressure: HostLoad['pressure']
    swapUsed: number
    swapTotal: number
    swapGrowthBytesPerSec: number | null
    freeMem: number
  }
}

function admissionRecord(
  at: number,
  started: number,
  decision: HostCapacityDecision,
  load: HostLoad,
  facts: { heldWork: number; recentAdmissions: number },
): RunHostAdmission {
  return {
    at: new Date(at).toISOString(),
    decision: decision.admit ? 'admit' : 'hold',
    heldOn: decision.heldOn,
    boundReached: decision.boundReached,
    waitedMs: at - started,
    sample: {
      loadavg: load.loadavg,
      cpuBusy: load.cpuBusy,
      ncpu: load.ncpu,
      recentAdmissions: facts.recentAdmissions,
      heldWork: facts.heldWork,
      pressure: load.pressure,
      swapUsed: load.swapUsed,
      swapTotal: load.swapTotal,
      swapGrowthBytesPerSec: load.swapGrowthBytesPerSec,
      freeMem: load.freeMem,
    },
  }
}

function decideAndRecordAdmission(input: {
  database: Database
  runId: string
  at: number
  started: number
  platform: NodeJS.Platform
  load: HostLoad
  samplesByAgent: Map<string, number[]>
}) {
  return writeTransaction(() => {
    const result = capacityDecision(input)
    const record = admissionRecord(
      input.at,
      input.started,
      result.decision,
      result.load,
      result.admissionFacts,
    )
    input.database
      .query(
        `UPDATE run SET host_admission_first=COALESCE(host_admission_first,?),
                        host_admission=CASE WHEN ? THEN ? ELSE host_admission END,
                        host_wait_since=CASE WHEN ? THEN NULL ELSE host_wait_since END
          WHERE record_id=?`,
      )
      .run(
        JSON.stringify(record),
        result.decision.admit ? 1 : 0,
        JSON.stringify(record),
        result.decision.admit ? 1 : 0,
        input.runId,
      )
    return result
  }, input.database)
}

export type RunHostCapacityQueue = {
  waiting: number
  oldestWaitMs: number
  heldOn: HostHoldCondition[]
}

/** Read-only snapshot of runs waiting on host capacity, using the same admission facts as the wait loop. */
export function runHostCapacityQueue(
  database: Database,
  now = Date.now(),
  deps: {
    env?: NodeJS.ProcessEnv
    platform?: NodeJS.Platform
    measure?: typeof measureHostLoad
  } = {},
): RunHostCapacityQueue {
  const waiters = runHostCapacityWaiters(database)
  if (!waiters.length) return { waiting: 0, oldestWaitMs: 0, heldOn: [] }
  const head = waiters[0]!
  const started = Date.parse(head.host_wait_since)
  const oldestWaitMs = Number.isFinite(started) ? Math.max(0, now - started) : 0
  const decision = capacityDecision({
    database,
    runId: head.record_id,
    at: now,
    started: Number.isFinite(started) ? started : now,
    platform: deps.platform ?? process.platform,
    load: (deps.measure ?? measureHostLoad)(
      deps.env ?? process.env,
      process.pid,
      deps.platform ?? process.platform,
      now,
    ),
    samplesByAgent: new Map(),
  })
  return { waiting: waiters.length, oldestWaitMs, heldOn: decision.decision.heldOn }
}

function waitCause(
  heldOn: Array<HostHoldCondition | 'migration'>,
  outcome: RunHostCapacityWait['outcome'],
  boundReached: boolean,
): string {
  if (boundReached) return `${heldOn.join('+')}:bound-reached`
  return `${heldOn.join('+')}${outcome === 'stopped' ? ':stopped' : ''}`
}

function finishWait(input: {
  database: Database
  runId: string
  at: number
  started: number
  heldOn: Set<HostHoldCondition | 'migration'>
  outcome: RunHostCapacityWait['outcome']
  boundReached?: boolean
  drainingFor: string | null
  hostLoad: RecordedHostLoad | null
}): RunHostCapacityWait {
  if (input.outcome === 'stopped')
    input.database.query('UPDATE run SET host_wait_since=NULL WHERE record_id=?').run(input.runId)
  const result = {
    outcome: input.outcome,
    waitedMs: input.at - input.started,
    heldOn: [...input.heldOn],
    boundReached: input.boundReached ?? false,
    drainingFor: input.drainingFor,
  }
  tryWriteContention({
    resourceKind: 'cpu',
    resourceKey: 'host-capacity',
    eventKind: 'wait',
    durationMs: result.waitedMs,
    cause: waitCause(result.heldOn, result.outcome, result.boundReached),
    runId: input.runId,
    hostLoad: input.hostLoad,
  })
  return result
}

export type RunHostCapacityWait = {
  outcome: 'admitted' | 'stopped'
  waitedMs: number
  heldOn: Array<HostHoldCondition | 'migration'>
  boundReached: boolean
  drainingFor: string | null
}

/** Apply the shared operator-facing policy for a completed host-capacity wait. */
export function raiseForHostCapacityWait(
  wait: RunHostCapacityWait | null,
  runId: string,
  stopped: boolean,
): void {
  if (wait?.drainingFor) {
    throw new Error(
      `run stopped for migration drain ${wait.drainingFor}; re-dispatch after ${PLATFORM_SLUG} machine update finishes`,
    )
  }
  if (wait?.boundReached) {
    const message = `host capacity wait bound reached after ${wait.waitedMs}ms; starting run`
    console.error(`orch: ${message}`)
    recordRunWarning(runId, message)
  }
  if (stopped) throw new Error('run stopped while waiting for host capacity')
}

type RunHostWaitLoop = {
  database: Database
  runId: string
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  now: () => number
  sleep: (ms: number) => Promise<void>
  random: () => number
  measure: typeof measureHostLoad
  existingChain: boolean
}

type WaitLoopStep = { done: false } | { done: true; result: RunHostCapacityWait | null }

function stoppedWaitStep(
  running: boolean,
  waiting: boolean,
  finish: (outcome: RunHostCapacityWait['outcome']) => RunHostCapacityWait,
): WaitLoopStep {
  if (running) return { done: false }
  return { done: true, result: waiting ? finish('stopped') : null }
}

function admittedWaitStep(
  decision: HostCapacityDecision,
  waiting: boolean,
  running: boolean,
  finish: (outcome: RunHostCapacityWait['outcome'], boundReached?: boolean) => RunHostCapacityWait,
): WaitLoopStep {
  if (!decision.admit) return { done: false }
  if (!waiting) return { done: true, result: null }
  if (!running) return { done: true, result: finish('stopped') }
  return { done: true, result: finish('admitted', decision.boundReached) }
}

function shouldResampleInitialLoad(
  decision: HostCapacityDecision,
  cpuBusy: number | null,
  alreadyResampled: boolean,
): boolean {
  return (
    !alreadyResampled && !decision.admit && cpuBusy === null && decision.heldOn.includes('load')
  )
}

async function runHostWaitLoop(input: RunHostWaitLoop): Promise<RunHostCapacityWait | null> {
  const started = input.now()
  const heldOn = new Set<HostHoldCondition | 'migration'>()
  let drainingFor: string | null = null
  let waiting = false
  let sampledInitialLoad = false
  let nextDecisionUsesResample = false
  let lastHeldHostLoad: RecordedHostLoad | null = null
  let previousPollMs: number | undefined
  const samplesByAgent = new Map<string, number[]>()
  const finish = (at: number, outcome: RunHostCapacityWait['outcome'], boundReached = false) =>
    finishWait({
      database: input.database,
      runId: input.runId,
      at,
      started,
      heldOn,
      outcome,
      boundReached,
      drainingFor,
      hostLoad: lastHeldHostLoad,
    })
  for (;;) {
    const at = input.now()
    const stopped = stoppedWaitStep(runIsRunning(input.database, input.runId), waiting, (outcome) =>
      finish(at, outcome),
    )
    if (stopped.done) return stopped.result
    const drain = activeMigrationDrain(input.database)
    if (drain && (drain.marker.phase === 'migrating' || !input.existingChain)) {
      drainingFor = drain.marker.migration
      heldOn.add('migration')
      return finish(at, 'stopped')
    }
    const measuredLoad = input.measure(input.env, process.pid, input.platform, at)
    const { decision, load, reservedCores } = decideAndRecordAdmission({
      database: input.database,
      runId: input.runId,
      at,
      started,
      platform: input.platform,
      load: measuredLoad,
      samplesByAgent,
    })
    const decisionUsesResample = nextDecisionUsesResample
    nextDecisionUsesResample = false
    if (shouldResampleInitialLoad(decision, load.cpuBusy, sampledInitialLoad)) {
      sampledInitialLoad = true
      nextDecisionUsesResample = true
      await input.sleep(CAPACITY_SAMPLE_MIN_WINDOW_MS)
      continue
    }
    const admitted = admittedWaitStep(
      decision,
      waiting,
      runIsRunning(input.database, input.runId),
      (outcome, boundReached) => finish(at, outcome, boundReached),
    )
    if (admitted.done) return admitted.result
    lastHeldHostLoad = recordedHostLoad(load, {
      resampled: decisionUsesResample,
      reservedCores,
    })
    for (const condition of decision.heldOn) heldOn.add(condition)
    if (!waiting) {
      waiting = true
      input.database
        .query('UPDATE run SET host_wait_since=? WHERE record_id=?')
        .run(nowIso(), input.runId)
    }
    const poll = nextRunCapacityPoll(previousPollMs, input.random())
    previousPollMs = poll.baseMs
    const waitedMs = at - started
    await input.sleep(Math.min(poll.delayMs, Math.max(0, RUN_HOST_WAIT_MAX_MS - waitedMs)))
  }
}

export async function waitForRunHostCapacity(input: {
  database: Database
  runId: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  random?: () => number
  measure?: typeof measureHostLoad
  existingChain?: boolean
}): Promise<RunHostCapacityWait | null> {
  const now = input.now ?? Date.now
  const sleep =
    input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const env = input.env ?? process.env
  if (env.CI) return null
  return runHostWaitLoop({
    database: input.database,
    runId: input.runId,
    env,
    platform: input.platform ?? process.platform,
    now,
    sleep,
    random: input.random ?? Math.random,
    measure: input.measure ?? measureHostLoad,
    existingChain: input.existingChain ?? false,
  })
}

export async function waitForLiveRunHostCapacity(input: {
  database: Database
  runId: string
  repoJob: boolean
  existingChain: boolean
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  random?: () => number
  measure?: typeof measureHostLoad
}): Promise<RunHostCapacityWait | null> {
  if (!input.repoJob) return null
  const admitted = input.database
    .query('SELECT host_admission FROM run WHERE record_id=?')
    .get(input.runId) as { host_admission: string | null } | null
  if (admitted?.host_admission != null) return null
  return waitForRunHostCapacity(input)
}

/** Keep the final status check adjacent to the spawn it guards. */
export async function startRunAfterHostCapacity<T>(input: {
  wait: () => Promise<RunHostCapacityWait | null>
  isRunning: () => boolean
  spawn: () => Promise<T>
  stop: (handle: T) => Promise<void>
}): Promise<{ handle: T | null; wait: RunHostCapacityWait | null }> {
  const wait = await input.wait()
  if (wait?.outcome === 'stopped' || !input.isRunning()) return { handle: null, wait }
  const handle = await input.spawn()
  if (!input.isRunning()) {
    await input.stop(handle)
    return { handle: null, wait }
  }
  return { handle, wait }
}
