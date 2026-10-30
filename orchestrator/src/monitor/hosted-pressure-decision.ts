// concern: hosted-pressure-decision
/** Decides hosted pressure and hysteresis from plain observations. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { MonitorCondition } from './monitor-types.ts'

export const HOSTED_STEAL_THRESHOLD = 0.2
export const HOSTED_THROTTLE_THRESHOLD = 0.1
export const HOSTED_API_P95_THRESHOLD_SECONDS = 2
export const HOSTED_PRESSURE_CLEAR_MS = 15 * 60_000

type HostedMeasure = 'steal' | 'throttle' | 'api-p95'
export type HostedPressureState = {
  status: 'clear' | 'pressure'
  onsetAt: string | null
  belowSince: string | null
  breachedMeasures: HostedMeasure[]
}
type Value = number | 'absent'
export type HostedPressureSample = {
  kind: 'sample'
  stealFraction: Value
  throttleFraction: Value
  balance: Value
  apiP95Seconds: Value
  at: string
}
export type HostedPressureObservation =
  | HostedPressureSample
  | { kind: 'unconfigured'; at: string }
  | { kind: 'failed'; query: string; error: string; at: string }

export type HostedPressureDecision = {
  state: HostedPressureState
  conditions: MonitorCondition[]
}

export const CLEAR_HOSTED_PRESSURE_STATE: HostedPressureState = {
  status: 'clear',
  onsetAt: null,
  belowSince: null,
  breachedMeasures: [],
}

const action = 'feature lanes hold new dispatch; read-only work continues'

function observationError(
  observation: HostedPressureObservation,
  detail: string,
  series?: 'steal' | 'api-p95',
): MonitorCondition {
  return {
    kind: 'observation-error',
    subject: `hosted-metrics:${observation.kind === 'failed' ? observation.query : (series ?? 'sample')}`,
    since: observation.at,
    ageMs: 0,
    detail,
    action: 'reported; restore the hosted metrics observation',
  }
}

function pressureCondition(
  state: HostedPressureState,
  observation: HostedPressureSample | Extract<HostedPressureObservation, { kind: 'failed' }>,
): MonitorCondition {
  const value = (item: Value) => (item === 'absent' ? 'absent' : String(item))
  const latest =
    observation.kind === 'sample'
      ? `latest steal=${value(observation.stealFraction)}, ` +
        `throttle=${value(observation.throttleFraction)}, balance=${value(observation.balance)}, ` +
        `api-p95=${value(observation.apiP95Seconds)}s`
      : `latest observation failed at ${observation.query}`
  return {
    kind: 'hosted-pressure',
    subject: 'hosted-record',
    since: state.onsetAt,
    ageMs: state.onsetAt
      ? Math.max(0, Date.parse(observation.at) - Date.parse(state.onsetAt))
      : null,
    severity: 'attention',
    detail: `breached ${state.breachedMeasures.join(', ')}; ${latest}; onset ${state.onsetAt}`,
    action,
  }
}

function failedDecision(
  previous: HostedPressureState,
  observation: Extract<HostedPressureObservation, { kind: 'failed' }>,
): HostedPressureDecision {
  const error = observationError(
    observation,
    `hosted metrics query ${observation.query} failed: ${observation.error}`,
  )
  return {
    state: previous,
    conditions:
      previous.status === 'pressure' ? [pressureCondition(previous, observation), error] : [error],
  }
}

function sampleErrors(observation: HostedPressureSample): MonitorCondition[] {
  const errors: MonitorCondition[] = []
  if (observation.stealFraction === 'absent') {
    errors.push(
      observationError(observation, 'hosted metrics query steal returned no series', 'steal'),
    )
  }
  if (observation.apiP95Seconds === 'absent') {
    errors.push(
      observationError(observation, 'hosted metrics query api-p95 returned no series', 'api-p95'),
    )
  }
  return errors
}

function breachedMeasures(observation: HostedPressureSample): HostedMeasure[] {
  const breached: HostedMeasure[] = []
  if (observation.stealFraction !== 'absent' && observation.stealFraction >= HOSTED_STEAL_THRESHOLD)
    breached.push('steal')
  if (
    observation.throttleFraction !== 'absent' &&
    observation.throttleFraction > HOSTED_THROTTLE_THRESHOLD
  )
    breached.push('throttle')
  if (
    observation.apiP95Seconds !== 'absent' &&
    observation.apiP95Seconds >= HOSTED_API_P95_THRESHOLD_SECONDS
  )
    breached.push('api-p95')
  return breached
}

/** Advance one pressure episode; failed observations never advance its clear window. */
export function decideHostedPressure(
  previous: HostedPressureState,
  observation: HostedPressureObservation,
): HostedPressureDecision {
  if (observation.kind === 'unconfigured') {
    return {
      state: previous,
      conditions: [
        {
          kind: 'hosted-metrics-unconfigured',
          subject: 'hosted-record',
          since: observation.at,
          ageMs: 0,
          severity: 'informational',
          detail: 'hosted Fly metrics are not configured',
          action: `${PLATFORM_SLUG} machine config secret set BOTTEGA_FLY_METRICS_TOKEN`,
        },
      ],
    }
  }
  if (observation.kind === 'failed') return failedDecision(previous, observation)
  const errors = sampleErrors(observation)
  const breached = breachedMeasures(observation)
  if (breached.length > 0) {
    const state: HostedPressureState = {
      status: 'pressure',
      onsetAt: previous.status === 'pressure' ? previous.onsetAt : observation.at,
      belowSince: null,
      breachedMeasures: [...new Set([...previous.breachedMeasures, ...breached])],
    }
    return { state, conditions: [pressureCondition(state, observation), ...errors] }
  }
  if (errors.length > 0) {
    return {
      state: previous,
      conditions:
        previous.status === 'pressure'
          ? [pressureCondition(previous, observation), ...errors]
          : errors,
    }
  }
  if (previous.status === 'clear') return { state: CLEAR_HOSTED_PRESSURE_STATE, conditions: [] }
  const belowSince = previous.belowSince ?? observation.at
  if (Date.parse(observation.at) - Date.parse(belowSince) >= HOSTED_PRESSURE_CLEAR_MS) {
    return { state: CLEAR_HOSTED_PRESSURE_STATE, conditions: [] }
  }
  const state = { ...previous, belowSince }
  return { state, conditions: [pressureCondition(state, observation)] }
}
