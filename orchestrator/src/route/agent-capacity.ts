// concern: agent capacity admission
/** Pure wait-or-refuse decision plus the bounded polling adapter. */

import { RUN_HOST_WAIT_MAX_MS, RUN_HOST_WAIT_POLL_MS } from '../run/run-host-capacity.ts'

export class AgentCapacityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AgentCapacityError'
  }
}

export type CapacityWaitDecision = 'select' | 'wait' | 'refuse'

export function decideCapacityWait(input: {
  capacityBlocked: boolean
  noWait: boolean
  waitedMs: number
}): CapacityWaitDecision {
  if (!input.capacityBlocked) return 'select'
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
        capacityBlocked: true,
        noWait: Boolean(input.noWait),
        waitedMs: now() - started,
      })
      if (decision === 'refuse') throw error
      if (!announced) {
        announced = true
        input.onWait?.(new Date(now()).toISOString())
      }
      await sleep(RUN_HOST_WAIT_POLL_MS)
    }
  }
}
