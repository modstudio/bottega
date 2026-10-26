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
): string | null {
  if (delegationMode(requestedJob.needs, settings) === 'external') return null
  const jobClass = delegationClass(requestedJob.needs)
  const setting = DELEGATION_SETTING_KEYS[jobClass]
  return (
    `this machine runs ${jobClass} work through the harness's own sub-agent (${setting}=harness)\n` +
    `cleared by: ${delegationRemedy(jobClass, 'external')}`
  )
}

function delegationRemedy(jobClass: DelegationClass, mode: DelegationMode): string {
  return `${PLATFORM_SLUG} machine config set --machine ${DELEGATION_SETTING_KEYS[jobClass]} ${mode}`
}

export function noEligibleAgentRefusal(
  jobName: string,
  capabilities: { writesRepo?: boolean },
  excluded: readonly string[],
): string {
  const headline = `no eligible agent for job "${jobName}"`
  const jobClass = delegationClass(capabilities)
  const detail = excluded.length ? `\n${excluded.join('\n')}` : ''
  return (
    `${headline}${detail}\nremedy: register and probe an agent with ` +
    `${PLATFORM_SLUG} agent add and ${PLATFORM_SLUG} agent probe, or switch ${jobClass} work ` +
    `to the harness with ${delegationRemedy(jobClass, 'harness')}`
  )
}
