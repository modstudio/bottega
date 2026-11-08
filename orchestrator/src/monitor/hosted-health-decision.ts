// concern: hosted-health-decision
/** Purely derives client-observed hosted health from recent call outcomes. */

import type { HostedCallOutcome, HostedTransportError } from '../hosted-call-outcome.ts'

export const HOSTED_HEALTH_WINDOW_MS = 5 * 60_000
export const HOSTED_UNREACHABLE_MIN_FAILURES = 3
export const HOSTED_DEGRADED_MIN_CALLS = 5
export const HOSTED_DEGRADED_SHARE = 0.5
export const HOSTED_DEGRADED_LATENCY_MS = 3_000

export type HostedHealthOutcome = Pick<
  HostedCallOutcome,
  'observedAt' | 'httpStatus' | 'latencyMs'
> & { transportError: HostedTransportError | null }

type HostedHealth = 'healthy' | 'degraded' | 'unreachable' | 'unknown'
export type HostedHealthDecision = {
  health: HostedHealth
  counts: { calls: number; failures: number; slow: number; recentFailures: number }
  latestSuccess: boolean | null
}

const failed = (outcome: HostedHealthOutcome): boolean =>
  outcome.transportError !== null || (outcome.httpStatus !== null && outcome.httpStatus >= 500)

const successfulRoundTrip = (outcome: HostedHealthOutcome): boolean =>
  outcome.transportError === null &&
  outcome.httpStatus !== null &&
  outcome.httpStatus >= 200 &&
  outcome.httpStatus < 500

export function hostedHealthFromOutcomes(
  outcomes: readonly HostedHealthOutcome[],
  now: number,
): HostedHealthDecision {
  const windowStart = now - HOSTED_HEALTH_WINDOW_MS
  const recent = outcomes
    .filter((outcome) => {
      const instant = Date.parse(outcome.observedAt)
      return instant >= windowStart && instant <= now
    })
    .sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt))
  const failures = recent.filter(failed).length
  const slow = recent.filter((outcome) => outcome.latencyMs > HOSTED_DEGRADED_LATENCY_MS).length
  let recentFailures = 0
  for (let index = recent.length - 1; index >= 0 && failed(recent[index]!); index -= 1)
    recentFailures += 1
  const counts = { calls: recent.length, failures, slow, recentFailures }
  const latestSuccess = recent.length === 0 ? null : successfulRoundTrip(recent.at(-1)!)
  if (
    failures >= HOSTED_UNREACHABLE_MIN_FAILURES &&
    recentFailures >= HOSTED_UNREACHABLE_MIN_FAILURES
  )
    return { health: 'unreachable', counts, latestSuccess }
  if (recent.length >= HOSTED_DEGRADED_MIN_CALLS && slow / recent.length >= HOSTED_DEGRADED_SHARE)
    return { health: 'degraded', counts, latestSuccess }
  if (recent.length < HOSTED_UNREACHABLE_MIN_FAILURES)
    return { health: 'unknown', counts, latestSuccess }
  return { health: 'healthy', counts, latestSuccess }
}
