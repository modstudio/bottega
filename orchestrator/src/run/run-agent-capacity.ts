// concern: agent capacity admission
/** Pure wait-or-refuse decision plus the bounded polling adapter. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { nowIso } from '../database/db.ts'
import { appendRunEvent } from '../events.ts'
import { AgentCapacityError } from '../route/routing-refusal.ts'
import { type RunningRunCounts, runningRunCountsForAgents } from '../route/running-runs.ts'
import { nextRunCapacityPoll, RUN_HOST_WAIT_MAX_MS } from './run-host-capacity.ts'
import { DETACHED_AGENT_CAPACITY_WAIT_MAX_MS } from './run-liveness-policy.ts'

export type CapacityWaitDecision = 'wait' | 'refuse'

export function capacityStartupFailure(
  error: unknown,
  runId: string | undefined,
): [error: unknown, started?: number, options?: { failureKind: 'capacity' }] {
  if (!(error instanceof AgentCapacityError) || !runId) return [error]
  return [
    new Error(`${error.message}\ncleared by: ${PLATFORM_SLUG} run retry ${runId}`),
    undefined,
    { failureKind: 'capacity' },
  ]
}

export function decideCapacityWait(input: {
  noWait: boolean
  waitedMs: number
  detached: boolean
}): CapacityWaitDecision {
  if (input.noWait || input.waitedMs >= agentCapacityWaitMaxMs(input.detached)) return 'refuse'
  return 'wait'
}

export function agentCapacityWaitMaxMs(detached: boolean): number {
  return detached ? DETACHED_AGENT_CAPACITY_WAIT_MAX_MS : RUN_HOST_WAIT_MAX_MS
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
): { retrySelection: boolean; pollMs: number | undefined } {
  const retrySelection = runningCountsMayHaveFreed(before, after)
  return {
    retrySelection,
    pollMs: retrySelection ? undefined : priorPollMs,
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

function selectAtCapacityBound<T>(
  select: () => T,
  lastError: AgentCapacityError,
  noWait: boolean,
  detached: boolean,
  maxWaitMs: number,
): T {
  if (noWait) throw refusalAtWaitBound(lastError, true, detached, maxWaitMs)
  try {
    return select()
  } catch (error) {
    if (!(error instanceof AgentCapacityError)) throw error
    throw refusalAtWaitBound(error, false, detached, maxWaitMs)
  }
}

export async function waitForAgentSelection<T>(input: {
  select: () => T
  noWait?: boolean
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  random?: () => number
  runningCounts?: (agents: readonly string[]) => RunningRunCounts
  onWait?: (at: string) => void
  detached?: boolean
}): Promise<T> {
  const now = input.now ?? Date.now
  const sleep =
    input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const started = now()
  let announced = false
  let previousPollMs: number | undefined
  let lastCapacityError: AgentCapacityError | null = null
  const detached = Boolean(input.detached)
  const maxWaitMs = agentCapacityWaitMaxMs(detached)
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
    const decision = decideCapacityWait({ noWait: Boolean(input.noWait), waitedMs, detached })
    if (decision === 'refuse')
      return selectAtCapacityBound(
        input.select,
        lastCapacityError,
        Boolean(input.noWait),
        detached,
        maxWaitMs,
      )
    announced = announceCapacityWait(announced, input.onWait, now())
    const poll = nextRunCapacityPoll(previousPollMs, (input.random ?? Math.random)())
    await sleep(Math.min(poll.delayMs, maxWaitMs - waitedMs))
    const agents = Object.keys(lastCapacityError.runningCounts)
    const currentCounts = (input.runningCounts ?? runningRunCountsForAgents)(agents)
    const next = nextCapacityWaitState(poll.baseMs, lastCapacityError.runningCounts, currentCounts)
    previousPollMs = next.pollMs
    if (next.retrySelection) lastCapacityError = null
  }
}

function refusalAtWaitBound(
  error: AgentCapacityError,
  noWait: boolean,
  detached: boolean,
  maxWaitMs: number,
): AgentCapacityError {
  return noWait
    ? error
    : new AgentCapacityError(
        `${error.message}; capacity wait bound reached after ${maxWaitMs}ms` +
          (detached
            ? ''
            : `\ncleared by: retry this command with ${PLATFORM_SLUG} run start --detach`),
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
    detached: Boolean(input.runId),
    onWait: (at) => {
      waiting = true
      if (input.runId) appendRunEvent(input.runId, { ts: at, type: 'capacity_wait', waiting: true })
    },
  })
  if (waiting && input.runId)
    appendRunEvent(input.runId, { ts: nowIso(), type: 'capacity_wait', waiting: false })
  return selected
}
