import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  DELEGATION_SETTING_KEYS,
  type DelegationSettings,
  delegationClass,
  delegationMode,
} from '../../../shared/delegation-mode.ts'
import type { Job } from './jobs.ts'

export function harnessDelegationRefusal(
  requestedJob: Pick<Job, 'needs'>,
  settings: DelegationSettings,
): string | null {
  if (delegationMode(requestedJob.needs, settings) === 'external') return null
  const jobClass = delegationClass(requestedJob.needs)
  const setting = DELEGATION_SETTING_KEYS[jobClass]
  return (
    `this machine runs ${jobClass} work through the harness's own sub-agent (${setting}=harness)\n` +
    `cleared by: ${PLATFORM_SLUG} machine config set --machine ${setting} external`
  )
}
