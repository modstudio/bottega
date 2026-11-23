// concern: standing-condition-announcement
/** Pure standing-board-notice decisions for persistent unowned monitor conditions. */

import type { HostedBoardOverviewEntry } from '../record/record-board-contract.ts'
import { COLLECTOR_LEG_FAILURE_WARN_MS } from './collector-leg-conditions.ts'
import type { MonitorCondition } from './monitor-types.ts'

export const STANDING_CONDITION_NOTICE_PREFIX = 'Monitor condition:'
export const STANDING_CONDITION_NOTICE_TTL_MS = 24 * 60 * 60_000
export const STANDING_CONDITION_DETAIL_LINE_CHARS = 160

export const COLLECTOR_LEG_FAILURE_NOTICE_THRESHOLD_MS = COLLECTOR_LEG_FAILURE_WARN_MS
export const RECORD_TUNNEL_DOWN_NOTICE_THRESHOLD_MS = 5 * 60_000
export const STORE_WRITE_LOCK_HELD_NOTICE_THRESHOLD_MS = 10 * 60_000
export const DISK_PRESSURE_NOTICE_THRESHOLD_MS = 10 * 60_000
export const OUTBOX_QUARANTINED_NOTICE_THRESHOLD_MS = 30 * 60_000
const RELEASE_LIVE_DIFFERS_NOTICE_THRESHOLD_MS = 30 * 60_000

const ANNOUNCED_STANDING_CONDITION_KINDS = [
  'collector-leg-failure',
  'record-tunnel-down',
  'store-write-lock-held',
  'disk-pressure',
  'outbox-quarantined',
  'release-live-differs',
] as const

export const POINT_IN_TIME_STANDING_CONDITION_KINDS = ['disk-pressure'] as const

export type AnnouncedStandingConditionKind = (typeof ANNOUNCED_STANDING_CONDITION_KINDS)[number]

const THRESHOLDS: Record<AnnouncedStandingConditionKind, number> = {
  'collector-leg-failure': COLLECTOR_LEG_FAILURE_NOTICE_THRESHOLD_MS,
  'record-tunnel-down': RECORD_TUNNEL_DOWN_NOTICE_THRESHOLD_MS,
  'store-write-lock-held': STORE_WRITE_LOCK_HELD_NOTICE_THRESHOLD_MS,
  'disk-pressure': DISK_PRESSURE_NOTICE_THRESHOLD_MS,
  'outbox-quarantined': OUTBOX_QUARANTINED_NOTICE_THRESHOLD_MS,
  'release-live-differs': RELEASE_LIVE_DIFFERS_NOTICE_THRESHOLD_MS,
}

type OpenNotice = Pick<HostedBoardOverviewEntry, 'id' | 'title'>
type StandingNotice = { title: string; body: string; expiresMs: number }
export type StandingConditionAnnouncementAction =
  | { kind: 'withdraw'; id: string }
  | { kind: 'post'; notice: StandingNotice }

export type StandingConditionCandidate = {
  condition: Pick<MonitorCondition, 'kind' | 'subject' | 'detail' | 'action'> & {
    kind: AnnouncedStandingConditionKind
  }
  /** Adapter-resolved onset, retained as plain evidence for the decision. */
  onset: string
  persistedMs: number
}

function cappedDetailLine(detail: string): string {
  const line = detail.split(/\r?\n/, 1)[0] || 'detail unavailable'
  return line.length <= STANDING_CONDITION_DETAIL_LINE_CHARS
    ? line
    : `${line.slice(0, STANDING_CONDITION_DETAIL_LINE_CHARS - 1)}…`
}

export function standingConditionNoticeTitle(
  kind: AnnouncedStandingConditionKind,
  subject: string,
): string {
  return kind === 'collector-leg-failure'
    ? `${STANDING_CONDITION_NOTICE_PREFIX} collector leg ${subject}`
    : `${STANDING_CONDITION_NOTICE_PREFIX} ${kind}`
}

function titleFor(candidate: StandingConditionCandidate): string {
  return standingConditionNoticeTitle(candidate.condition.kind, candidate.condition.subject)
}

function noticeKind(title: string): AnnouncedStandingConditionKind | null {
  const collectorPrefix = `${STANDING_CONDITION_NOTICE_PREFIX} collector leg `
  if (title.startsWith(collectorPrefix)) return 'collector-leg-failure'
  return (
    ANNOUNCED_STANDING_CONDITION_KINDS.find(
      (kind) => kind !== 'collector-leg-failure' && title === standingConditionNoticeTitle(kind, ''),
    ) ?? null
  )
}

function noticeFor(group: readonly StandingConditionCandidate[]): StandingNotice {
  const oldest = [...group].sort(
    (left, right) =>
      right.persistedMs - left.persistedMs ||
      left.condition.subject.localeCompare(right.condition.subject),
  )[0]!
  const minutes = Math.floor(oldest.persistedMs / 60_000)
  const count = group.length
  const countText =
    oldest.condition.kind === 'collector-leg-failure'
      ? `Collector leg ${oldest.condition.subject}`
      : `${count} live ${oldest.condition.kind} condition${count === 1 ? '' : 's'}; oldest ${oldest.condition.subject}`
  return {
    title: titleFor(oldest),
    body:
      `${countText} has persisted for ${minutes} minutes since ${oldest.onset}. ` +
      `Detail: ${cappedDetailLine(oldest.condition.detail)}. ` +
      `Remedy: ${oldest.condition.action}`,
    expiresMs: STANDING_CONDITION_NOTICE_TTL_MS,
  }
}

function groupedCandidates(
  candidates: readonly StandingConditionCandidate[],
): StandingConditionCandidate[][] {
  const groups = new Map<string, StandingConditionCandidate[]>()
  for (const candidate of candidates) {
    if (!isAnnouncedStandingConditionKind(candidate.condition.kind)) continue
    const key =
      candidate.condition.kind === 'collector-leg-failure'
        ? `${candidate.condition.kind}:${candidate.condition.subject}`
        : candidate.condition.kind
    const group = groups.get(key) ?? []
    group.push(candidate)
    groups.set(key, group)
  }
  return [...groups.values()]
}

/** Return posts and withdrawals for the complete currently-live announced set. */
export function decideStandingConditionAnnouncement(
  candidates: readonly StandingConditionCandidate[],
  openNotices: readonly OpenNotice[],
  unobservedKinds: ReadonlySet<AnnouncedStandingConditionKind> = new Set(),
): StandingConditionAnnouncementAction[] {
  const ours = openNotices.filter((notice) =>
    notice.title?.startsWith(`${STANDING_CONDITION_NOTICE_PREFIX} `),
  )
  const groups = groupedCandidates(candidates)
  const liveTitles = new Set(groups.map((group) => titleFor(group[0]!)))
  const openTitles = new Set(ours.map((notice) => notice.title))
  return [
    ...ours
      .filter(
        (notice) =>
          !liveTitles.has(notice.title!) &&
          !unobservedKinds.has(noticeKind(notice.title!) as AnnouncedStandingConditionKind),
      )
      .map((notice) => ({ kind: 'withdraw', id: notice.id }) as const),
    ...groups
      .filter((group) =>
        group.some((candidate) => candidate.persistedMs >= THRESHOLDS[candidate.condition.kind]),
      )
      .filter((group) => !openTitles.has(titleFor(group[0]!)))
      .map((group) => ({ kind: 'post', notice: noticeFor(group) }) as const),
  ]
}

export function isAnnouncedStandingConditionKind(
  kind: string,
): kind is AnnouncedStandingConditionKind {
  return (ANNOUNCED_STANDING_CONDITION_KINDS as readonly string[]).includes(kind)
}
