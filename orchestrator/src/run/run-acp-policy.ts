// concern: run-acp-policy
/**
 * Keeps the router's metered-agent decision intact when the selected agent is
 * validated immediately before launch.
 */
import type { Agent } from '../agent/agents.ts'
import { job } from '../jobs/jobs.ts'
import { meteredRouteEligibility } from '../route/route.ts'
import { assertAcpAllowed } from '../transport/transport.ts'
import { namedAgentTurn } from './run-resume-kind.ts'

export function assertSelectedAcpAllowed(
  jobName: string,
  agent: Agent,
  agentExplicit: boolean | undefined,
  firstTurn: boolean,
): void {
  const automaticallyEligible = meteredRouteEligibility({
    billing: agent.billing,
    routeMetered: Boolean(agent.routeMetered),
    writesRepo: Boolean(job(jobName).needs.writesRepo),
    name: agent.name,
    explicitlyNamedAgent: agentExplicit ? agent.name : undefined,
  }).mayAutoRouteNamedJob
  assertAcpAllowed(
    jobName,
    agent.name,
    agent,
    namedAgentTurn(agentExplicit, firstTurn),
    automaticallyEligible,
  )
}
