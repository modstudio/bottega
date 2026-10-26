export const DELEGATION_CLASSES = ['implement', 'review'] as const
export type DelegationClass = (typeof DELEGATION_CLASSES)[number]

export const DELEGATION_MODES = ['external', 'harness'] as const
export type DelegationMode = (typeof DELEGATION_MODES)[number]

export const DELEGATION_SETTING_KEYS = {
  implement: 'delegation.implement',
  review: 'delegation.review',
} as const satisfies Record<DelegationClass, string>

export type DelegationSettings = Record<
  (typeof DELEGATION_SETTING_KEYS)[DelegationClass],
  DelegationMode
>
