import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  DELEGATION_SETTING_KEYS,
  type DelegationClass,
  type DelegationMode,
  type DelegationSettings,
} from '../../../shared/delegation-mode.ts'
import type { Job } from './jobs.ts'

const DELEGATION_CLASS_LABELS = {
  implement: 'repository-writing jobs',
  review: 'read-only jobs (all jobs that do not write the repository)',
} as const satisfies Record<DelegationClass, string>

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

export function isHarnessDelegated(
  capabilities: { writesRepo?: boolean },
  settings: DelegationSettings,
): boolean {
  return delegationMode(capabilities, settings) === 'harness'
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

export function noEligibleAgentRefusal(options: {
  jobName: string
  capabilities: { writesRepo?: boolean }
  excluded: readonly string[]
  undeclaredAgents: readonly string[]
}): string {
  const { jobName, capabilities, excluded, undeclaredAgents } = options
  const headline = `no eligible agent for job "${jobName}"`
  const jobClass = delegationClass(capabilities)
  const detail = excluded.length ? `\n${excluded.join('\n')}` : ''
  const remedies = []
  if (undeclaredAgents.length) {
    remedies.push(
      `declare a probed agent: ${PLATFORM_SLUG} agent set <agent> --jobs <current jobs and ${jobName}, comma-separated>, then ${PLATFORM_SLUG} agent probe <agent> if its last probe did not cover ${jobName}`,
    )
  }
  remedies.push(
    `register and probe an agent with ${PLATFORM_SLUG} agent add and ${PLATFORM_SLUG} agent probe`,
    `switch ${DELEGATION_CLASS_LABELS[jobClass]} to the harness with ${delegationRemedy(jobClass, 'harness')}`,
  )
  return `${headline}${detail}\nremedy: ${remedies.join('; or ')}`
}
