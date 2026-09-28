// concern: run-bootstrap
/** Knows only whether a reserved run's coordinator handoff was abandoned. */

import type { RunLeaseState } from './run-alive.ts'

/**
 * How long a `(pending)` row may sit before a missing coordinator handoff is
 * considered abandoned bootstrap.
 *
 * detach() inserts the reserved row, then spawns the worker, then records the
 * pid. A spawn error or a coordinator death in that handoff leaves
 * agent='(pending)', status='running'. That is not an agent run. After this
 * bound, an absent/dead pid or free lease is failed/harness instead.
 */
export const PENDING_BOOTSTRAP_MS = 60_000

type BootstrapFacts = {
  agent: string
  pid: number | null
  pidAlive: boolean
  leaseState: RunLeaseState
  startedAt: string
  now: number
}

type CoordinatorSetupFacts = {
  agent: string
  agentPidPresent: boolean
  leaseState: RunLeaseState
  pidAlive: boolean
}

/** Decide whether a reserved run was abandoned before its coordinator claimed it. */
export function abandonedBootstrap(facts: BootstrapFacts): boolean {
  if (facts.agent !== '(pending)') return false
  if (Date.parse(facts.startedAt) >= facts.now - PENDING_BOOTSTRAP_MS) return false
  return facts.pid === null || !facts.pidAlive || facts.leaseState === 'free'
}

/** Decide whether a claimed coordinator died before it started the agent. */
export function coordinatorSetupDeath(facts: CoordinatorSetupFacts): boolean {
  return (
    facts.agent !== '(pending)' &&
    !facts.agentPidPresent &&
    facts.leaseState !== 'held' &&
    !facts.pidAlive
  )
}
