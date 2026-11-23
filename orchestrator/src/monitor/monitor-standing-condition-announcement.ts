// concern: monitor-standing-condition-announcement
/** Resolves persistence and applies standing condition notices without failing a monitor pass. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  decideStandingConditionAnnouncement,
  isAnnouncedStandingConditionKind,
  POINT_IN_TIME_STANDING_CONDITION_KINDS,
  STANDING_CONDITION_NOTICE_PREFIX,
  standingConditionNoticeTitle,
  type AnnouncedStandingConditionKind,
  type StandingConditionCandidate,
} from './standing-condition-announcement.ts'
import {
  announceHostedPressureActions,
  type HostedPressureAnnouncementDependencies,
} from './monitor-hosted-pressure.ts'
import type { MonitorCondition } from './monitor-types.ts'

type FinishedKindObservation = { started_at: string; present: number }

/** Resolve the first retained pass in the current uninterrupted episode. */
export function standingConditionHistoryOnset(
  database: Database,
  kind: string,
  currentStartedAt: string,
): string {
  const rows = database
    .query<FinishedKindObservation, [string]>(
      `SELECT invocation.started_at,
              EXISTS(SELECT 1 FROM monitor_condition condition
                      WHERE condition.invocation_record_id=invocation.record_id
                        AND condition.kind=?) present
         FROM monitor_invocation invocation
        WHERE invocation.finished_at IS NOT NULL
        ORDER BY invocation.started_at`,
    )
    .all(kind)
  let lastAbsent = -1
  for (let index = 0; index < rows.length; index++) if (!rows[index]!.present) lastAbsent = index
  if (lastAbsent === -1) return rows[0]?.started_at ?? currentStartedAt
  return rows.slice(lastAbsent + 1).find((row) => row.present)?.started_at ?? currentStartedAt
}

function candidateFor(
  database: Database,
  condition: MonitorCondition,
  clock: number,
  currentStartedAt: string,
): StandingConditionCandidate | null {
  if (!isAnnouncedStandingConditionKind(condition.kind)) return null
  const parsedSince = condition.since === null ? Number.NaN : Date.parse(condition.since)
  const pointInTime = (POINT_IN_TIME_STANDING_CONDITION_KINDS as readonly string[]).includes(
    condition.kind,
  )
  const onset = !pointInTime && Number.isFinite(parsedSince)
    ? condition.since!
    : !pointInTime && condition.ageMs !== null
      ? new Date(clock - condition.ageMs).toISOString()
      : standingConditionHistoryOnset(database, condition.kind, currentStartedAt)
  const persistedMs = pointInTime
    ? Math.max(0, clock - Date.parse(onset))
    : (condition.ageMs ?? Math.max(0, clock - Date.parse(onset)))
  return {
    condition: {
      kind: condition.kind,
      subject: condition.subject,
      detail: condition.detail,
      action: condition.action,
    },
    onset,
    persistedMs,
  }
}

function announcementError(error: unknown): { errors: string[] } {
  return { errors: [`standing condition announcement failed: ${String(error)}`] }
}

/** Reconcile all announced kinds once for a normal monitor pass. */
export async function announceStandingConditions(
  database: Database,
  conditions: readonly MonitorCondition[],
  clock: number,
  currentStartedAt: string,
  dependencies: HostedPressureAnnouncementDependencies = {},
  unobservedKinds: ReadonlySet<AnnouncedStandingConditionKind> = new Set(),
): Promise<{ errors: string[] }> {
  try {
    const candidates = conditions.flatMap((condition) => {
      const candidate = candidateFor(database, condition, clock, currentStartedAt)
      return candidate ? [candidate] : []
    })
    await announceHostedPressureActions(
      (messages) => decideStandingConditionAnnouncement(candidates, messages, unobservedKinds),
      dependencies,
      clock,
      {
        prefix: STANDING_CONDITION_NOTICE_PREFIX,
        audience: `architects:${PLATFORM_SLUG}`,
      },
    )
    return { errors: [] }
  } catch (error) {
    return announcementError(error)
  }
}

/** Reconcile only the store-lock notice while the normal pass cannot write its invocation. */
export async function announceStoreWriteLockCondition(
  database: Database,
  condition: MonitorCondition,
  clock: number,
  dependencies: HostedPressureAnnouncementDependencies = {},
): Promise<{ errors: string[] }> {
  let onset: string
  try {
    const latest = database
      .query<{ finished_at: string }, []>(
        `SELECT finished_at FROM monitor_invocation
          WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1`,
      )
      .get()
    if (!latest) return { errors: [] }
    onset = latest.finished_at
  } catch {
    return { errors: [] }
  }
  const persistedMs = Math.max(0, clock - Date.parse(onset))
  const candidate: StandingConditionCandidate = {
    condition: {
      kind: 'store-write-lock-held',
      subject: condition.subject,
      detail: condition.detail,
      action: condition.action,
    },
    onset,
    persistedMs,
  }
  try {
    const title = standingConditionNoticeTitle('store-write-lock-held', condition.subject)
    await announceHostedPressureActions(
      (messages) =>
        decideStandingConditionAnnouncement(
          [candidate],
          messages.filter((message) => message.title === title),
        ),
      dependencies,
      clock,
      {
        prefix: STANDING_CONDITION_NOTICE_PREFIX,
        audience: `architects:${PLATFORM_SLUG}`,
      },
    )
    return { errors: [] }
  } catch (error) {
    return announcementError(error)
  }
}
