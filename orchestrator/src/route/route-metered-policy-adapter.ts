// concern: metered route policy adapter
/** Supplies job write policy to the pure metered-provider admission decision. */

import type { Agent } from '../agent/agents.ts'
import { job } from '../jobs/jobs.ts'
import { meteredRouteEligibility } from './route-metered-policy.ts'

export function agentMeteredRouteEligibility(
  jobName: string,
  agent: Pick<Agent, 'billing' | 'routeMetered' | 'name' | 'trainsOnInputs'>,
  explicitlyNamedAgent?: string,
): ReturnType<typeof meteredRouteEligibility> {
  return meteredRouteEligibility({
    billing: agent.billing,
    routeMetered: Boolean(agent.routeMetered),
    trainsOnInputs: Boolean(agent.trainsOnInputs),
    writesRepo: Boolean(job(jobName).needs.writesRepo),
    name: agent.name,
    explicitlyNamedAgent,
  })
}
