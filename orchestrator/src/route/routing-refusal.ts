// concern: routing-refusal
import type { Refusal } from '../../../shared/refusal.ts'
import { RefusalError } from '../refusal-error.ts'

/** Stable cross-process names for refusals raised by routing. */
export const ROUTING_REFUSAL_ERROR_NAME = 'RoutingRefusalError'
export const AGENT_CAPACITY_ERROR_NAME = `${ROUTING_REFUSAL_ERROR_NAME}.AgentCapacityError`
export const ROUTING_REFUSAL_MARKER = ROUTING_REFUSAL_ERROR_NAME

export class RoutingRefusalError extends RefusalError {
  constructor(refusal: Refusal) {
    super(refusal)
    this.name = ROUTING_REFUSAL_ERROR_NAME
  }
}

export class AgentCapacityError extends RoutingRefusalError {
  readonly runningCounts: Readonly<Record<string, number>>

  constructor(refusal: Refusal, runningCounts: Readonly<Record<string, number>>) {
    super(refusal)
    this.name = AGENT_CAPACITY_ERROR_NAME
    this.runningCounts = runningCounts
  }
}
