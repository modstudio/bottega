// concern: hosted-board-verification-policy
/** Decides when a hosted board verification episode warrants a heartbeat notice. */

export const BOARD_UNVERIFIED_NOTICE_AFTER_MS = 5 * 60 * 1_000

export type HostedBoardVerificationNoticeDecision =
  | 'announce-unverified'
  | 'announce-recovered'
  | null

export function hostedBoardVerificationNoticeDecision(input: {
  currentlyUnverified: boolean
  lastVerifiedAt: string | null
  now: number
  unverifiedNoticeAnnounced: boolean
}): HostedBoardVerificationNoticeDecision {
  if (!input.currentlyUnverified)
    return input.unverifiedNoticeAnnounced ? 'announce-recovered' : null
  if (input.unverifiedNoticeAnnounced) return null
  const lastVerifiedAt = input.lastVerifiedAt ? Date.parse(input.lastVerifiedAt) : Number.NaN
  if (!Number.isFinite(lastVerifiedAt)) return 'announce-unverified'
  return input.now - lastVerifiedAt >= BOARD_UNVERIFIED_NOTICE_AFTER_MS
    ? 'announce-unverified'
    : null
}
