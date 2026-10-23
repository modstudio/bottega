// concern: run host-capacity admission
/** Knows the repository-run host wait adapter. Must not know transports or routing. */

import type { Database } from 'bun:sqlite'
import { nowIso, tryWriteContention } from '../database/db.ts'
import {
  decideHostCapacityAdmission,
  HOST_LOAD_RESERVATION_MS,
  type HostHoldCondition,
  measureHostLoad,
} from '../gate-load.ts'

export const RUN_HOST_WAIT_MAX_MS = 15 * 60_000
export const RUN_HOST_WAIT_POLL_MS = 1_000

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
  recentAdmissions: number
  hasOlderWaiter: boolean
}

type RunHostCapacityWaiter = {
  record_id: string
  host_wait_since: string
}

/** Admission's FIFO waiter set: running repository rows still waiting on host capacity. */
function runHostCapacityWaiters(database: Database): RunHostCapacityWaiter[] {
  return database
    .query(
      `SELECT record_id, host_wait_since FROM run
        WHERE status='running' AND worktree IS NOT NULL AND host_wait_since IS NOT NULL
        ORDER BY host_wait_since ASC, record_id ASC`,
    )
    .all() as RunHostCapacityWaiter[]
}

function runningRepositoryFacts(
  database: Database,
  runId: string,
  now: number,
): RunningRepositoryFacts {
  const rows = database
    .query(
      `SELECT agent_start_time FROM run
        WHERE status='running' AND worktree IS NOT NULL AND host_wait_since IS NULL AND record_id<>?`,
    )
    .all(runId) as { agent_start_time: string | null }[]
  return {
    running: rows.length,
    recentAdmissions: rows.filter((row) => {
      const admittedAt = Date.parse(row.agent_start_time ?? '')
      return Number.isFinite(admittedAt) && now - admittedAt < HOST_LOAD_RESERVATION_MS
    }).length,
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
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  measure: typeof measureHostLoad
}) {
  const repositories = runningRepositoryFacts(input.database, input.runId, input.at)
  const load = input.measure(input.env, process.pid, input.platform, input.at)
  return decideHostCapacityAdmission({
    heldWork: repositories.running,
    loadavg: load.loadavg,
    ncpu: load.ncpu,
    recentAdmissions: load.recentAdmissions + repositories.recentAdmissions,
    freeMem: load.freeMem,
    pressure: load.pressure,
    limit: null,
    platform: input.platform,
    waitedMs: input.at - input.started,
    maxWaitMs: RUN_HOST_WAIT_MAX_MS,
    hasOlderWaiter: repositories.hasOlderWaiter,
  })
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
    env: deps.env ?? process.env,
    platform: deps.platform ?? process.platform,
    measure: deps.measure ?? measureHostLoad,
  })
  return { waiting: waiters.length, oldestWaitMs, heldOn: decision.heldOn }
}

function waitCause(
  heldOn: HostHoldCondition[],
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
  heldOn: Set<HostHoldCondition>
  outcome: RunHostCapacityWait['outcome']
  boundReached?: boolean
}): RunHostCapacityWait {
  if (input.outcome === 'stopped')
    input.database.query('UPDATE run SET host_wait_since=NULL WHERE record_id=?').run(input.runId)
  const result = {
    outcome: input.outcome,
    waitedMs: input.at - input.started,
    heldOn: [...input.heldOn],
    boundReached: input.boundReached ?? false,
  }
  tryWriteContention({
    resourceKind: 'cpu',
    resourceKey: 'host-capacity',
    eventKind: 'wait',
    durationMs: result.waitedMs,
    cause: waitCause(result.heldOn, result.outcome, result.boundReached),
    runId: input.runId,
  })
  return result
}

export type RunHostCapacityWait = {
  outcome: 'admitted' | 'stopped'
  waitedMs: number
  heldOn: HostHoldCondition[]
  boundReached: boolean
}

type RunHostWaitLoop = {
  database: Database
  runId: string
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  now: () => number
  sleep: (ms: number) => Promise<void>
  measure: typeof measureHostLoad
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
  decision: ReturnType<typeof capacityDecision>,
  waiting: boolean,
  running: boolean,
  finish: (outcome: RunHostCapacityWait['outcome'], boundReached?: boolean) => RunHostCapacityWait,
): WaitLoopStep {
  if (!decision.admit) return { done: false }
  if (!waiting) return { done: true, result: null }
  if (!running) return { done: true, result: finish('stopped') }
  return { done: true, result: finish('admitted', decision.boundReached) }
}

async function runHostWaitLoop(input: RunHostWaitLoop): Promise<RunHostCapacityWait | null> {
  const started = input.now()
  const heldOn = new Set<HostHoldCondition>()
  let waiting = false
  const finish = (at: number, outcome: RunHostCapacityWait['outcome'], boundReached = false) =>
    finishWait({
      database: input.database,
      runId: input.runId,
      at,
      started,
      heldOn,
      outcome,
      boundReached,
    })
  for (;;) {
    const at = input.now()
    const stopped = stoppedWaitStep(runIsRunning(input.database, input.runId), waiting, (outcome) =>
      finish(at, outcome),
    )
    if (stopped.done) return stopped.result
    const decision = capacityDecision({ ...input, at, started })
    const admitted = admittedWaitStep(
      decision,
      waiting,
      runIsRunning(input.database, input.runId),
      (outcome, boundReached) => finish(at, outcome, boundReached),
    )
    if (admitted.done) return admitted.result
    for (const condition of decision.heldOn) heldOn.add(condition)
    if (!waiting) {
      waiting = true
      input.database
        .query('UPDATE run SET host_wait_since=? WHERE record_id=?')
        .run(nowIso(), input.runId)
    }
    await input.sleep(RUN_HOST_WAIT_POLL_MS)
  }
}

export async function waitForRunHostCapacity(input: {
  database: Database
  runId: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  measure?: typeof measureHostLoad
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
    measure: input.measure ?? measureHostLoad,
  })
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
