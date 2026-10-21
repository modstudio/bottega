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

const RUN_HOST_WAIT_MAX_MS = 15 * 60_000
const RUN_HOST_WAIT_POLL_MS = 1_000

type RunningRepositoryFacts = { running: number; recentAdmissions: number }

function runningRepositoryFacts(
  database: Database,
  runId: string,
  now: number,
): RunningRepositoryFacts {
  const rows = database
    .query(
      `SELECT agent_start_time FROM run
        WHERE status='running' AND repo IS NOT NULL AND record_id<>?`,
    )
    .all(runId) as { agent_start_time: string | null }[]
  return {
    running: rows.length,
    recentAdmissions: rows.filter((row) => {
      const admittedAt = Date.parse(row.agent_start_time ?? '')
      return Number.isFinite(admittedAt) && now - admittedAt < HOST_LOAD_RESERVATION_MS
    }).length,
  }
}

export type RunHostCapacityWait = {
  waitedMs: number
  heldOn: HostHoldCondition[]
  boundReached: boolean
}

export async function waitForRunHostCapacity(input: {
  database: Database
  runId: string
  skip: boolean
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  measure?: typeof measureHostLoad
}): Promise<RunHostCapacityWait | null> {
  if (input.skip) return null
  const now = input.now ?? Date.now
  const sleep =
    input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const env = input.env ?? process.env
  if (env.CI) return null
  const platform = input.platform ?? process.platform
  const started = now()
  const heldOn = new Set<HostHoldCondition>()
  let waiting = false
  for (;;) {
    const at = now()
    const repositories = runningRepositoryFacts(input.database, input.runId, at)
    const load = (input.measure ?? measureHostLoad)(env, process.pid, platform, at)
    const decision = decideHostCapacityAdmission({
      heldWork: repositories.running,
      loadavg: load.loadavg,
      ncpu: load.ncpu,
      recentAdmissions: load.recentAdmissions + repositories.recentAdmissions,
      freeMem: load.freeMem,
      pressure: load.pressure,
      limit: null,
      platform,
      waitedMs: at - started,
      maxWaitMs: RUN_HOST_WAIT_MAX_MS,
    })
    if (decision.admit) {
      if (!waiting) return null
      const result = {
        waitedMs: at - started,
        heldOn: [...heldOn],
        boundReached: decision.boundReached,
      }
      tryWriteContention({
        resourceKind: 'cpu',
        resourceKey: 'host-capacity',
        eventKind: 'wait',
        durationMs: result.waitedMs,
        cause: `${result.heldOn.join('+')}${result.boundReached ? ':bound-reached' : ''}`,
        runId: input.runId,
      })
      return result
    }
    for (const condition of decision.heldOn) heldOn.add(condition)
    if (!waiting) {
      waiting = true
      input.database
        .query('UPDATE run SET host_wait_since=? WHERE record_id=?')
        .run(nowIso(), input.runId)
    }
    await sleep(RUN_HOST_WAIT_POLL_MS)
  }
}
