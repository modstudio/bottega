export const MODERATION_HIDE_REASONS = [
  'spam',
  'abuse',
  'off-topic',
  'personal-data',
  'duplicate',
] as const

export type ModerationHideReason = (typeof MODERATION_HIDE_REASONS)[number]

export function isModerationHideReason(value: unknown): value is ModerationHideReason {
  return MODERATION_HIDE_REASONS.includes(value as ModerationHideReason)
}
