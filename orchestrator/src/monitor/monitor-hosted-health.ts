// concern: monitor-hosted-health
/** Reads client-observed hosted outcomes and owns their hosted-pressure notice source. */

import type { Database } from 'bun:sqlite'
import type { HostedTransportError } from '../hosted-call-outcome.ts'
import { machineNames } from '../record/machine-identity.ts'
import type { HostedBoardOverviewEntry } from '../record/record-board-contract.ts'
import {
  HOSTED_HEALTH_WINDOW_MS,
  type HostedHealthDecision,
  type HostedHealthOutcome,
  hostedHealthFromOutcomes,
} from './hosted-health-decision.ts'
import {
  HOSTED_CLIENT_HEALTH_NOTICE_PREFIX,
  HOSTED_PRESSURE_NOTICE_TTL_MS,
  type HostedPressureAnnouncementAction,
} from './hosted-pressure-announcement.ts'
import {
  announceHostedPressureActions,
  type HostedPressureAnnouncementDependencies,
} from './monitor-hosted-pressure.ts'
import type { MonitorCondition } from './monitor-types.ts'

type HostedCallOutcomeRow = {
  observed_at: string
  http_status: number | null
  transport_error: HostedTransportError | null
  latency_ms: number
}

const countsText = ({ counts }: HostedHealthDecision): string =>
  `${counts.calls} calls, ${counts.failures} failures, ${counts.recentFailures} consecutive recent failures, ${counts.slow} slow calls`

export function announcementActions(
  decision: HostedHealthDecision,
  messages: Pick<HostedBoardOverviewEntry, 'id' | 'title'>[],
  machine: string,
): HostedPressureAnnouncementAction[] {
  const machinePrefix = `${HOSTED_CLIENT_HEALTH_NOTICE_PREFIX} ${machine} `
  const open = messages.filter((message) => message.title?.startsWith(machinePrefix))
  if (decision.health === 'unknown' && decision.latestSuccess !== true) return []
  if (decision.health === 'healthy' || decision.health === 'unknown')
    return open.map((message) => ({ kind: 'withdraw', id: message.id }))
  const title = `${machinePrefix}${decision.health}`
  const matching = open.some((message) => message.title === title)
  return [
    ...open
      .filter((message) => message.title !== title)
      .map((message) => ({ kind: 'withdraw', id: message.id }) as const),
    ...(matching
      ? []
      : [
          {
            kind: 'post' as const,
            notice: {
              title,
              body: `Client-observed hosted health is ${decision.health}: ${countsText(decision)}.`,
              expiresMs: HOSTED_PRESSURE_NOTICE_TTL_MS,
            },
          },
        ]),
  ]
}

export async function checkHostedHealth(
  database: Database,
  clock: number,
  announcement: HostedPressureAnnouncementDependencies = {},
): Promise<{ decision: HostedHealthDecision; conditions: MonitorCondition[] }> {
  const cutoff = new Date(clock - HOSTED_HEALTH_WINDOW_MS).toISOString()
  const outcomes = database
    .query<HostedCallOutcomeRow, [string]>(
      `SELECT observed_at,http_status,transport_error,latency_ms
       FROM hosted_call_outcome WHERE observed_at>=? ORDER BY observed_at`,
    )
    .all(cutoff)
    .map(
      (row): HostedHealthOutcome => ({
        observedAt: row.observed_at,
        httpStatus: row.http_status,
        transportError: row.transport_error,
        latencyMs: row.latency_ms,
      }),
    )
  const decision = hostedHealthFromOutcomes(outcomes, clock)
  const machine = machineNames().displayName
  let noticeActionSucceeded = true
  try {
    await announceHostedPressureActions(
      (messages) => announcementActions(decision, messages, machine),
      announcement,
      clock,
    )
  } catch {
    noticeActionSucceeded = false
    // The local condition remains the evidence when hosted cannot carry its own notice.
  }
  if (decision.health !== 'unreachable' && decision.health !== 'degraded')
    return { decision, conditions: [] }
  return {
    decision,
    conditions: [
      {
        kind: `hosted-${decision.health}`,
        subject: 'hosted-record',
        since: outcomes.at(-1)?.observedAt ?? null,
        ageMs: null,
        detail: `Hosted health is ${decision.health}: ${countsText(decision)}.`,
        action: noticeActionSucceeded
          ? 'reported; the hosted pressure notice follows this client-observed state'
          : 'reported; the hosted pressure notice could not be posted',
      },
    ],
  }
}
