import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  DELEGATION_SETTING_KEYS,
  type DelegationClass,
  type DelegationMode,
  type DelegationSettings,
} from '../../../shared/delegation-mode.ts'
import type { Job } from './jobs.ts'

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

export function harnessDelegationRefusal(
  requestedJob: Pick<Job, 'needs'>,
  settings: DelegationSettings,
  firstTurn = true,
): string | null {
  // An existing chain keeps its external worker; only a first turn chooses a delegation lane.
  if (!firstTurn) return null
  if (delegationMode(requestedJob.needs, settings) === 'external') return null
  const jobClass = delegationClass(requestedJob.needs)
  const setting = DELEGATION_SETTING_KEYS[jobClass]
  return (
    `this machine runs ${jobClass} work through the harness's own sub-agent (${setting}=harness)\n` +
    `cleared by: ${PLATFORM_SLUG} machine config set --machine ${setting} external`
  )
}
