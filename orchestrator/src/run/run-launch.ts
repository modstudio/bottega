import type { TransportName } from '../transport/transport.ts'

export type RunLaunchFacts = {
  resume: { parent: number; turn: number; agent: string } | null
  pickedAgent: string | null
  pickedReason: string | null
  requestedTransport: TransportName
  explicitTransport: boolean
  envTransport: boolean
  agentDefaultTransport: TransportName
}

export type RunLaunchRuling = {
  agent: string
  reason: string
  transport: TransportName
}

export function decideRunLaunch(facts: RunLaunchFacts): RunLaunchRuling {
  // A resumed turn stays with the vendor session that owns the conversation.
  const selected = facts.resume
    ? {
        agent: facts.resume.agent,
        reason:
          `resumed run ${facts.resume.parent} (turn ${facts.resume.turn}); ` +
          'repository path retargeting not applied because the turn is already bound to its worktree',
      }
    : { agent: facts.pickedAgent!, reason: facts.pickedReason! }
  return {
    ...selected,
    transport:
      facts.resume || facts.explicitTransport || facts.envTransport
        ? facts.requestedTransport
        : facts.agentDefaultTransport,
  }
}
