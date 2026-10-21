// concern: run-acp-policy
/**
 * Keeps the router's metered-agent decision intact when the selected agent is
 * validated immediately before launch.
 */
import type { Agent } from '../agent/agents.ts'
import { agentMeteredRouteEligibility } from '../route/route.ts'
import { assertAcpAllowed } from '../transport/transport.ts'
import { namedAgentTurn } from './run-resume-kind.ts'

export function assertSelectedAcpAllowed(
  jobName: string,
  agent: Agent,
  agentExplicit: boolean | undefined,
  firstTurn: boolean,
): void {
  const automaticallyEligible = agentMeteredRouteEligibility(
    jobName,
    agent,
    agentExplicit ? agent.name : undefined,
  ).mayAutoRouteNamedJob
  assertAcpAllowed(
    jobName,
    agent.name,
    agent,
    namedAgentTurn(agentExplicit, firstTurn),
    automaticallyEligible,
  )
}
