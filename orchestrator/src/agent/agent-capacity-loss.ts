// concern: agent-capacity-loss
/** Decides whether an agent identity change would empty a job's eligible pool. */

export type AgentCapacityFacts = {
  identityChanged: boolean
  currentEligibleJobs: readonly string[]
  otherEligibleAgentsByJob: Readonly<Record<string, readonly string[]>>
}

type RoutedAgent = { agent: string; eligible: boolean }

export function jobsLosingAgentCapacity(facts: AgentCapacityFacts): string[] {
  if (!facts.identityChanged) return []
  return facts.currentEligibleJobs.filter(
    (job) => (facts.otherEligibleAgentsByJob[job]?.length ?? 0) === 0,
  )
}

export function jobsLosingCapacityFromRouting(
  identityChanged: boolean,
  name: string,
  routedByJob: Readonly<Record<string, readonly RoutedAgent[]>>,
): string[] {
  if (!identityChanged) return []
  const currentEligibleJobs = Object.entries(routedByJob)
    .filter(([, routed]) =>
      routed.some((candidate) => candidate.agent === name && candidate.eligible),
    )
    .map(([job]) => job)
  return jobsLosingAgentCapacity({
    identityChanged,
    currentEligibleJobs,
    otherEligibleAgentsByJob: Object.fromEntries(
      currentEligibleJobs.map((job) => [
        job,
        routedByJob[job]!.filter((candidate) => candidate.agent !== name && candidate.eligible).map(
          (candidate) => candidate.agent,
        ),
      ]),
    ),
  })
}
