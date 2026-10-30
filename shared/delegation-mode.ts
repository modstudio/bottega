export const DELEGATION_CLASSES = ['implement', 'review'] as const
export type DelegationClass = (typeof DELEGATION_CLASSES)[number]

export const DELEGATION_MODES = ['external', 'harness'] as const
export type DelegationMode = (typeof DELEGATION_MODES)[number]

export const DELEGATION_SETTING_KEYS = {
  implement: 'delegation.implement',
  review: 'delegation.review',
} as const satisfies Record<DelegationClass, string>

export const DELEGATION_CLASS_LABELS = {
  implement: 'repository-writing jobs',
  review: 'read-only jobs (all jobs that do not write the repository)',
} as const satisfies Record<DelegationClass, string>

export type DelegationSettingKey =
  (typeof DELEGATION_SETTING_KEYS)[keyof typeof DELEGATION_SETTING_KEYS]

export function isDelegationKey(key: string): key is DelegationSettingKey {
  return Object.values(DELEGATION_SETTING_KEYS).includes(key as DelegationSettingKey)
}

export type DelegationSettings = Record<DelegationSettingKey, DelegationMode>
