import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { DELEGATION_SETTING_KEYS, delegationClass } from '../../../shared/delegation-mode.ts'

export function noEligibleAgentRefusal(
  jobName: string,
  capabilities: { writesRepo?: boolean },
  excluded: readonly string[],
): string {
  const headline = `no eligible agent for job "${jobName}"`
  if (excluded.length) return `${headline}\n${excluded.join('\n')}`
  const jobClass = delegationClass(capabilities)
  const setting = DELEGATION_SETTING_KEYS[jobClass]
  return (
    `${headline}\nremedy: register and probe an agent with ` +
    `${PLATFORM_SLUG} agent add and ${PLATFORM_SLUG} agent probe, or switch ${jobClass} work ` +
    `to the harness with ${PLATFORM_SLUG} machine config set --machine ${setting} harness`
  )
}
