// concern: run-acp-policy
/**
 * Keeps the router's metered-agent decision intact when the selected agent is
 * validated immediately before launch.
 */
import type { Agent } from '../agent/agents.ts'
import { agentMeteredRouteEligibility } from '../route/route.ts'
import { assertAcpAllowed } from '../transport/transport.ts'
import { namedAgentTurn } from './run-resume-kind.ts'

export function assertAcpPolicyAllowed(
  jobName: string,
  agentName: string | undefined,
  agent: Agent | undefined,
  namedTurn: boolean,
): void {
  const automaticallyEligible = agent
    ? agentMeteredRouteEligibility(jobName, agent, namedTurn ? agent.name : undefined)
        .mayAutoRouteNamedJob
    : false
  assertAcpAllowed(jobName, agentName, agent, namedTurn, automaticallyEligible)
}

export function assertSelectedAcpAllowed(
  jobName: string,
  agent: Agent,
  agentExplicit: boolean | undefined,
  firstTurn: boolean,
): void {
  assertAcpPolicyAllowed(jobName, agent.name, agent, namedAgentTurn(agentExplicit, firstTurn))
}
