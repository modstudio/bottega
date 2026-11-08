// concern: agent-set-capacity
/** Gathers routing facts and applies the capacity-loss guard around an agent identity change. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { refusal } from '../../../shared/refusal.ts'
import { JOBS } from '../jobs/jobs.ts'
import { RefusalError } from '../refusal-error.ts'
import { candidates } from '../route/route.ts'
import { jobsLosingCapacityFromRouting } from './agent-capacity-loss.ts'
import {
  type AgentMutation,
  type AgentRow,
  agentIdentityChanged,
  agentRows,
  setAgent,
} from './agent-registry.ts'

export type SetAgentCapacityResult = { row: AgentRow; capacityLossJobs: string[] }

export function setAgentWithCapacityGuard(
  name: string,
  input: AgentMutation,
  allowCapacityLoss: boolean,
): SetAgentCapacityResult {
  const current = agentRows().find((row) => row.name === name)
  if (!current) throw new Error(`unknown agent "${name}"`)
  const identityChanged = agentIdentityChanged(current, input)
  const routedByJob = identityChanged
    ? Object.fromEntries(Object.keys(JOBS).map((job) => [job, candidates(job)]))
    : {}
  const capacityLossJobs = jobsLosingCapacityFromRouting(identityChanged, name, routedByJob)
  if (capacityLossJobs.length && !allowCapacityLoss) {
    throw new RefusalError(
      refusal(
        `refusing identity change for agent "${name}": it would leave these jobs with no eligible agent: ${capacityLossJobs.join(', ')}`,
        {
          kind: 'edit',
          text:
            `register the new identity as a separate agent row with ${PLATFORM_SLUG} agent add, ` +
            `probe it with ${PLATFORM_SLUG} agent probe, then disable or change the old row\n` +
            'override: pass --allow-capacity-loss',
        },
      ),
    )
  }
  if (capacityLossJobs.length) {
    input.capacityLossAllowed = { jobs: capacityLossJobs, at: new Date().toISOString() }
  }
  return { row: setAgent(name, input), capacityLossJobs }
}
