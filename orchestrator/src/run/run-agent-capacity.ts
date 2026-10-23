// concern: agent capacity admission
/** Pure wait-or-refuse decision plus the bounded polling adapter. */

import { nowIso } from '../database/db.ts'
import { appendRunEvent } from '../events.ts'
import { AgentCapacityError } from '../route/routing-refusal.ts'
import { type RunningRunCounts, runningRunCountsForAgents } from '../route/running-runs.ts'
import {
  RUN_HOST_WAIT_MAX_MS,
  RUN_HOST_WAIT_POLL_CAP_MS,
  RUN_HOST_WAIT_POLL_MS,
} from './run-host-capacity.ts'

export type CapacityWaitDecision = 'wait' | 'refuse'

export function decideCapacityWait(input: {
  noWait: boolean
  waitedMs: number
}): CapacityWaitDecision {
  if (input.noWait || input.waitedMs >= RUN_HOST_WAIT_MAX_MS) return 'refuse'
  return 'wait'
}

export function nextCapacityPollMs(currentMs: number): number {
  return Math.min(currentMs * 2, RUN_HOST_WAIT_POLL_CAP_MS)
}

function runningCountsMayHaveFreed(
  before: Readonly<RunningRunCounts>,
  after: Readonly<RunningRunCounts>,
): boolean {
  return Object.keys(before).some((agent) => (after[agent] ?? 0) < (before[agent] ?? 0))
}

function nextCapacityWaitState(
  priorPollMs: number,
  before: Readonly<RunningRunCounts>,
  after: Readonly<RunningRunCounts>,
): { retrySelection: boolean; pollMs: number } {
  const retrySelection = runningCountsMayHaveFreed(before, after)
  return {
    retrySelection,
    pollMs: retrySelection ? RUN_HOST_WAIT_POLL_MS : nextCapacityPollMs(priorPollMs),
  }
}

function announceCapacityWait(
  announced: boolean,
  onWait: ((at: string) => void) | undefined,
  now: number,
): boolean {
  if (!announced) onWait?.(new Date(now).toISOString())
  return true
}

export async function waitForAgentSelection<T>(input: {
  select: () => T
  noWait?: boolean
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  runningCounts?: (agents: readonly string[]) => RunningRunCounts
  onWait?: (at: string) => void
}): Promise<T> {
  const now = input.now ?? Date.now
  const sleep =
    input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const started = now()
  let announced = false
  let pollMs = RUN_HOST_WAIT_POLL_MS
  let lastCapacityError: AgentCapacityError | null = null
  for (;;) {
    if (!lastCapacityError) {
      try {
        return input.select()
      } catch (error) {
        if (!(error instanceof AgentCapacityError)) throw error
        lastCapacityError = error
      }
    }
    const waitedMs = now() - started
    const decision = decideCapacityWait({ noWait: Boolean(input.noWait), waitedMs })
    if (decision === 'refuse') throw refusalAtWaitBound(lastCapacityError, Boolean(input.noWait))
    announced = announceCapacityWait(announced, input.onWait, now())
    await sleep(Math.min(pollMs, RUN_HOST_WAIT_MAX_MS - waitedMs))
    const agents = Object.keys(lastCapacityError.runningCounts)
    const currentCounts = (input.runningCounts ?? runningRunCountsForAgents)(agents)
    const next = nextCapacityWaitState(pollMs, lastCapacityError.runningCounts, currentCounts)
    pollMs = next.pollMs
    if (next.retrySelection) lastCapacityError = null
  }
}

function refusalAtWaitBound(error: AgentCapacityError, noWait: boolean): AgentCapacityError {
  return noWait
    ? error
    : new AgentCapacityError(
        `${error.message}; capacity wait bound reached after ${RUN_HOST_WAIT_MAX_MS}ms`,
        error.runningCounts,
      )
}

export async function selectAgentWithCapacityEvents<T>(input: {
  runId: string | undefined
  select: () => T
  noWait?: boolean
}): Promise<T> {
  let waiting = false
  const selected = await waitForAgentSelection({
    select: input.select,
    noWait: input.noWait,
    onWait: (at) => {
      waiting = true
      if (input.runId) appendRunEvent(input.runId, { ts: at, type: 'capacity_wait', waiting: true })
    },
  })
  if (waiting && input.runId)
    appendRunEvent(input.runId, { ts: nowIso(), type: 'capacity_wait', waiting: false })
  return selected
}
