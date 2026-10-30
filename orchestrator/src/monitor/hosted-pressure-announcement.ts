// concern: hosted-pressure-announcement
/** Decides board actions for a hosted-pressure state transition. */

import type { HostedBoardOverviewEntry } from '../record/record-board-contract.ts'
import {
  HOSTED_API_P95_THRESHOLD_SECONDS,
  HOSTED_STEAL_THRESHOLD,
  HOSTED_THROTTLE_THRESHOLD,
  type HostedPressureObservation,
  type HostedPressureSample,
  type HostedPressureState,
} from './hosted-pressure-decision.ts'

export const HOSTED_PRESSURE_NOTICE_PREFIX = 'Hosted pressure:'
export const HOSTED_PRESSURE_NOTICE_TTL_MS = 24 * 60 * 60_000
export const HOSTED_PRESSURE_CLEARED_TTL_MS = 60 * 60_000

type OpenNotice = Pick<HostedBoardOverviewEntry, 'id' | 'title'>
type Notice = { title: string; body: string; expiresMs: number }
export type HostedPressureAnnouncementAction =
  | { kind: 'withdraw'; id: string }
  | { kind: 'post'; notice: Notice }

const value = (sample: HostedPressureSample, measure: string): string => {
  if (measure === 'steal') return String(sample.stealFraction)
  if (measure === 'throttle') return String(sample.throttleFraction)
  return `${sample.apiP95Seconds}s`
}

const threshold = (measure: string): string => {
  if (measure === 'steal') return `>=${HOSTED_STEAL_THRESHOLD}`
  if (measure === 'throttle') return `>${HOSTED_THROTTLE_THRESHOLD}`
  return `>=${HOSTED_API_P95_THRESHOLD_SECONDS}s`
}

function onsetNotice(state: HostedPressureState, sample: HostedPressureSample): Notice {
  const measures = state.breachedMeasures.map((measure) => `${measure}=${value(sample, measure)}`)
  const details = state.breachedMeasures.map(
    (measure) => `${measure}=${value(sample, measure)} (threshold ${threshold(measure)})`,
  )
  return {
    title: `${HOSTED_PRESSURE_NOTICE_PREFIX} ${measures.join(', ')}`,
    body: `${details.join('; ')}. Onset: ${state.onsetAt}. Sessions may see slow or failing hosted calls.`,
    expiresMs: HOSTED_PRESSURE_NOTICE_TTL_MS,
  }
}

function clearedNotice(previous: HostedPressureState, clearedAt: string): Notice {
  return {
    title: `${HOSTED_PRESSURE_NOTICE_PREFIX} cleared`,
    body: `Hosted pressure that began at ${previous.onsetAt} cleared at ${clearedAt}.`,
    expiresMs: HOSTED_PRESSURE_CLEARED_TTL_MS,
  }
}

/** Return the complete board mutation plan for one observation. */
export function decideHostedPressureAnnouncement(
  previous: HostedPressureState,
  state: HostedPressureState,
  observation: HostedPressureObservation,
  openNotices: OpenNotice[],
): HostedPressureAnnouncementAction[] {
  if (observation.kind !== 'sample' || previous.status === state.status) return []
  const onsetNotices = openNotices.filter(
    (notice) =>
      notice.title?.startsWith(`${HOSTED_PRESSURE_NOTICE_PREFIX} `) &&
      notice.title !== `${HOSTED_PRESSURE_NOTICE_PREFIX} cleared`,
  )
  if (previous.status === 'clear' && state.status === 'pressure') {
    return onsetNotices.length > 0
      ? []
      : [{ kind: 'post', notice: onsetNotice(state, observation) }]
  }
  return [
    ...onsetNotices.map((notice) => ({ kind: 'withdraw', id: notice.id }) as const),
    { kind: 'post', notice: clearedNotice(previous, observation.at) },
  ]
}
