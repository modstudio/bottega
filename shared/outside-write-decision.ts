// concern: outside-write-decision
/** Pure abuse-limit decision for signed-in writers outside a space. */

import { PLATFORM_SLUG } from './brand.ts'

export const OUTSIDE_MIN_ACCOUNT_AGE_MS = 24 * 60 * 60 * 1000
export const OUTSIDE_WRITES_PER_HOUR = 5
export const OUTSIDE_WRITES_PER_DAY = 20
export const OUTSIDE_BODY_MAX_CHARS = 2000
export const OUTSIDE_AREA_MAX_CHARS = 200
export const OUTSIDE_LINK_MAX = 2
export const OUTSIDE_PAUSE_DEFAULT_HOURS = 24
export const OUTSIDE_PAUSE_MAX_HOURS = 720

export function isOutsidePauseHours(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= OUTSIDE_PAUSE_MAX_HOURS
}

export type OutsideWriteDecision =
  | { allowed: true }
  | { allowed: false; status: 400 | 403 | 413 | 429; refusal: string }

const linkPattern = /https?:\/\/[^\s]+/giu

function leavesWindow(oldest: Date | null, windowMs: number): string {
  return new Date((oldest?.getTime() ?? 0) + windowMs).toISOString()
}

export function outsideWriteDecision(input: {
  now: Date
  createdAt: Date
  emailVerified: boolean
  body: string
  area: string | null
  anchorLength: number
  writesLastHour: number
  writesLastDay: number
  oldestWriteLastHour: Date | null
  oldestWriteLastDay: Date | null
}): OutsideWriteDecision {
  if (!input.emailVerified)
    return {
      allowed: false,
      status: 403,
      refusal: `email is not verified; verify your email with \`${PLATFORM_SLUG} record verify-email\`, then post again`,
    }
  const eligibleAt = new Date(input.createdAt.getTime() + OUTSIDE_MIN_ACCOUNT_AGE_MS)
  if (input.now < eligibleAt)
    return {
      allowed: false,
      status: 403,
      refusal: `account is too new for outside posts; post again after ${eligibleAt.toISOString()}`,
    }
  if (input.body.length > OUTSIDE_BODY_MAX_CHARS)
    return {
      allowed: false,
      status: 413,
      refusal: `outside post body is too long; shorten the post to ${OUTSIDE_BODY_MAX_CHARS} characters`,
    }
  if ((input.area?.length ?? 0) > OUTSIDE_AREA_MAX_CHARS)
    return {
      allowed: false,
      status: 413,
      refusal: `outside note area is too long; shorten the area to ${OUTSIDE_AREA_MAX_CHARS} characters`,
    }
  if (input.anchorLength > OUTSIDE_BODY_MAX_CHARS)
    return {
      allowed: false,
      status: 413,
      refusal: `outside note anchor is too long; shorten the serialized anchor to ${OUTSIDE_BODY_MAX_CHARS} characters`,
    }
  const links = input.body.match(linkPattern)?.length ?? 0
  if (links > OUTSIDE_LINK_MAX)
    return {
      allowed: false,
      status: 400,
      refusal: `outside post has too many links; use at most ${OUTSIDE_LINK_MAX} http:// or https:// links`,
    }
  if (input.writesLastHour >= OUTSIDE_WRITES_PER_HOUR)
    return {
      allowed: false,
      status: 429,
      refusal: `outside write limit of ${OUTSIDE_WRITES_PER_HOUR} per hour reached; post again after ${leavesWindow(input.oldestWriteLastHour, 60 * 60 * 1000)}`,
    }
  if (input.writesLastDay >= OUTSIDE_WRITES_PER_DAY)
    return {
      allowed: false,
      status: 429,
      refusal: `outside write limit of ${OUTSIDE_WRITES_PER_DAY} per day reached; post again after ${leavesWindow(input.oldestWriteLastDay, 24 * 60 * 60 * 1000)}`,
    }
  return { allowed: true }
}
