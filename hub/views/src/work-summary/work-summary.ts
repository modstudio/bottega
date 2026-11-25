import { collectedTime, relativeTime } from '@bottega/hub-util/format'

/** What every work page's response carries for its header and headline figures. */
export type ChromeResponse = {
  engaged: string
  activeAgents: string[]
  tasksShipped: number
  collectedAt: string | null
  collectorLegs?: CollectorLegHealth[]
  servingSince: string
  counts: { flight: number; done: number; runs: number }
}

export type CollectorLegHealth = {
  source: string
  lastSuccessAt: string | null
  lastError: string | null
  lastErrorAt: string | null
  failingSince: string | null
  consecutiveFailures?: number
  status: 'current' | 'failing' | 'stale' | 'unreadable'
  ageMs: number | null
  quarantinedRows?: number
  oldestQuarantinedRow?: {
    table: string
    constraintError: string
    firstQuarantinedAt: string
  } | null
}

function truncatedError(error: string): string {
  return error.length <= 120 ? error : `${error.slice(0, 119)}…`
}

export function responseSubtitle(response: {
  collectedAt: string | null
  collectorLegs?: CollectorLegHealth[]
  activeAgents: string[]
  servingSince: string
}) {
  const agent = `${response.activeAgents.length} agent${response.activeAgents.length === 1 ? '' : 's'} working`
  const unhealthy = response.collectorLegs?.find((leg) => leg.status !== 'current')
  if (unhealthy) {
    const state =
      unhealthy.status === 'failing'
        ? `failing since ${relativeTime(unhealthy.failingSince!)}`
        : unhealthy.status === 'unreadable'
          ? 'state is unreadable'
          : unhealthy.lastSuccessAt
            ? `stale since ${relativeTime(unhealthy.lastSuccessAt)}`
            : 'stale with no recorded success'
    const error = unhealthy.lastError ? ` · ${truncatedError(unhealthy.lastError)}` : ''
    return {
      text: `Collector ${unhealthy.source} ${state}${error}`,
      title: unhealthy.lastError ?? `Collector ${unhealthy.source} has not succeeded recently`,
    }
  }
  return {
    text: `${collectedTime(response.collectedAt)} \u00b7 ${agent}`,
    title: `Serving code from ${relativeTime(response.servingSince)}. ${response.activeAgents.length ? response.activeAgents.join(', ') : 'No agent on a task'}`,
  }
}
