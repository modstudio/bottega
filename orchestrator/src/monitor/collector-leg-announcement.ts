// concern: collector-leg-announcement
/** Decides board actions for sustained hub collector-leg failures. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { HostedBoardOverviewEntry } from '../record/record-board-contract.ts'
import type { CollectorLegFailure } from './collector-leg-conditions.ts'

export const COLLECTOR_LEG_FAILURE_NOTICE_PREFIX = 'Collector leg failure:'
export const COLLECTOR_LEG_FAILURE_NOTICE_TTL_MS = 24 * 60 * 60_000
export const COLLECTOR_LEG_ERROR_LINE_CHARS = 160

type OpenNotice = Pick<HostedBoardOverviewEntry, 'id' | 'title'>
type CollectorLegFailureNotice = { title: string; body: string; expiresMs: number }
export type CollectorLegFailureAnnouncementAction =
  | { kind: 'withdraw'; id: string }
  | { kind: 'post'; notice: CollectorLegFailureNotice }

function cappedErrorLine(error: string | null): string {
  const line = error?.split(/\r?\n/, 1)[0] || 'error unavailable'
  return line.length <= COLLECTOR_LEG_ERROR_LINE_CHARS
    ? line
    : `${line.slice(0, COLLECTOR_LEG_ERROR_LINE_CHARS - 1)}…`
}

function noticeFor(failure: CollectorLegFailure): CollectorLegFailureNotice {
  const ageMinutes = Math.floor(failure.ageMs / 60_000)
  return {
    title: `${COLLECTOR_LEG_FAILURE_NOTICE_PREFIX} ${failure.source}`,
    body:
      `${failure.source} collection has failed for ${ageMinutes} minutes since ${failure.failingSince}. ` +
      `Last error: ${cappedErrorLine(failure.lastError)}. ` +
      `Recovery: fix the named hub collector failure, then run ${PLATFORM_SLUG} record collector-legs --json to confirm recovery.`,
    expiresMs: COLLECTOR_LEG_FAILURE_NOTICE_TTL_MS,
  }
}

/** Return posts and withdrawals for the complete currently failing set. */
export function decideCollectorLegFailureAnnouncement(
  failures: readonly CollectorLegFailure[],
  openNotices: readonly OpenNotice[],
): CollectorLegFailureAnnouncementAction[] {
  const ours = openNotices.filter((notice) =>
    notice.title?.startsWith(`${COLLECTOR_LEG_FAILURE_NOTICE_PREFIX} `),
  )
  const openTitles = new Set(ours.map((notice) => notice.title))
  const failingTitles = new Set(
    failures.map((failure) => `${COLLECTOR_LEG_FAILURE_NOTICE_PREFIX} ${failure.source}`),
  )
  return [
    ...ours
      .filter((notice) => !failingTitles.has(notice.title!))
      .map((notice) => ({ kind: 'withdraw', id: notice.id }) as const),
    ...failures
      .filter(
        (failure) => !openTitles.has(`${COLLECTOR_LEG_FAILURE_NOTICE_PREFIX} ${failure.source}`),
      )
      .map((failure) => ({ kind: 'post', notice: noticeFor(failure) }) as const),
  ]
}
