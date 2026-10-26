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

export function delegationClass(capabilities: { writesRepo?: boolean }): DelegationClass {
  return capabilities.writesRepo ? 'implement' : 'review'
}

/** Decide where a declared job runs from capabilities and already-read machine settings. */
export function delegationMode(
  capabilities: { writesRepo?: boolean },
  settings: DelegationSettings,
): DelegationMode {
  return settings[DELEGATION_SETTING_KEYS[delegationClass(capabilities)]]
}
