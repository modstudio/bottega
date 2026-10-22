// concern: agent capacity admission
/** Pure wait-or-refuse decision plus the bounded polling adapter. */

import { nowIso } from '../database/db.ts'
import { appendRunEvent } from '../events.ts'
import { AgentCapacityError } from '../route/routing-refusal.ts'
import { RUN_HOST_WAIT_MAX_MS, RUN_HOST_WAIT_POLL_MS } from './run-host-capacity.ts'

export type CapacityWaitDecision = 'wait' | 'refuse'

export function decideCapacityWait(input: {
  noWait: boolean
  waitedMs: number
}): CapacityWaitDecision {
  if (input.noWait || input.waitedMs >= RUN_HOST_WAIT_MAX_MS) return 'refuse'
  return 'wait'
}

export async function waitForAgentSelection<T>(input: {
  select: () => T
  noWait?: boolean
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  onWait?: (at: string) => void
}): Promise<T> {
  const now = input.now ?? Date.now
  const sleep =
    input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const started = now()
  let announced = false
  for (;;) {
    try {
      return input.select()
    } catch (error) {
      if (!(error instanceof AgentCapacityError)) throw error
      const decision = decideCapacityWait({
        noWait: Boolean(input.noWait),
        waitedMs: now() - started,
      })
      if (decision === 'refuse') throw refusalAtWaitBound(error, Boolean(input.noWait))
      if (!announced) {
        announced = true
        input.onWait?.(new Date(now()).toISOString())
      }
      await sleep(RUN_HOST_WAIT_POLL_MS)
    }
  }
}

function refusalAtWaitBound(error: AgentCapacityError, noWait: boolean): AgentCapacityError {
  return noWait
    ? error
    : new AgentCapacityError(
        `${error.message}; capacity wait bound reached after ${RUN_HOST_WAIT_MAX_MS}ms`,
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
