// concern: closed session sweep decision
/** Decides whether the machine may finish one recorded session close-out. */

export type SessionCloseOutSweepFacts = {
  clean: boolean
  closedAt: number
  lastSeenAt: number | null
  sweptAt: number | null
}

export type SessionCloseOutSweepDecision =
  | { action: 'sweep' }
  | { action: 'skip'; reason: 'already-swept' | 'unclean' | 'resumed' }

export function decideSessionCloseOutSweep(
  facts: SessionCloseOutSweepFacts,
): SessionCloseOutSweepDecision {
  if (facts.sweptAt !== null) return { action: 'skip', reason: 'already-swept' }
  if (!facts.clean) return { action: 'skip', reason: 'unclean' }
  if (facts.lastSeenAt !== null && facts.lastSeenAt > facts.closedAt)
    return { action: 'skip', reason: 'resumed' }
  return { action: 'sweep' }
}

export type HostedReleaseFailure = 'final' | 'deferred-auth' | 'deferred'
export type HostedReleaseCircuitCause = 'auth' | 'record'
export type HostedReleaseAttempt =
  | { outcome: 'pending' }
  | { outcome: 'released'; released: number }
  | {
      outcome: 'failed'
      failure: HostedReleaseFailure
      message: string
      tripCircuit: boolean
    }

export type HostedReleaseRowDecision = {
  disposition: 'proceed' | 'stamp-final' | 'defer'
  message: string | null
  circuitCause: HostedReleaseCircuitCause | null
}

type HostedReleaseCause = {
  name?: unknown
  kind?: unknown
  status?: unknown
}

function hostedReleaseCause(cause: unknown): HostedReleaseCause {
  return cause !== null && typeof cause === 'object' ? cause : {}
}

export function hostedReleaseFailure(cause: unknown): HostedReleaseFailure {
  const { kind, status } = hostedReleaseCause(cause)
  if (status === 401 || status === 403) return 'deferred-auth'
  if (kind === 'refused' && [400, 409, 422].includes(typeof status === 'number' ? status : -1))
    return 'final'
  return 'deferred'
}

export function hostedReleaseTripsCircuit(cause: unknown): boolean {
  const { name, kind, status } = hostedReleaseCause(cause)
  return (
    name === 'BoundExceededError' ||
    kind === 'unreachable' ||
    kind === 'server' ||
    status === 401 ||
    status === 403 ||
    status === 408 ||
    status === 429 ||
    (typeof status === 'number' && status >= 500)
  )
}

export function decideHostedReleaseRow(input: {
  session: string
  enabled: boolean
  circuitCause: HostedReleaseCircuitCause | null
  attempt: HostedReleaseAttempt
  platformSlug: string
}): HostedReleaseRowDecision {
  if (!input.enabled) return { disposition: 'proceed', message: null, circuitCause: null }
  if (input.circuitCause !== null) {
    const remedy =
      input.circuitCause === 'auth'
        ? `sign in again: ${input.platformSlug} record sign-in`
        : `retry: ${input.platformSlug} machine sweep`
    return {
      disposition: 'defer',
      message: `skipped hosted claim release for closed session ${input.session}: the record was unreachable earlier in this sweep; ${remedy}`,
      circuitCause: input.circuitCause,
    }
  }
  if (input.attempt.outcome === 'pending' || input.attempt.outcome === 'released')
    return { disposition: 'proceed', message: null, circuitCause: null }
  if (input.attempt.failure === 'final')
    return {
      disposition: 'stamp-final',
      message: `hosted board claims of closed session ${input.session} were not released: ${input.attempt.message}; they are left to lapse`,
      circuitCause: null,
    }
  const auth = input.attempt.failure === 'deferred-auth'
  return {
    disposition: 'defer',
    message: `could not release hosted board claims of closed session ${input.session}: ${input.attempt.message}; ${auth ? `sign in again: ${input.platformSlug} record sign-in` : `retry: ${input.platformSlug} machine sweep`}`,
    circuitCause: input.attempt.tripCircuit ? (auth ? 'auth' : 'record') : null,
  }
}
