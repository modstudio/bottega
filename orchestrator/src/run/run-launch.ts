export type RunLaunchFacts = (
  | { source: 'resume'; parent: number; turn: number; agent: string }
  | { source: 'pick'; agent: string; reason: string }
) & {
  explicitTransport: boolean
  envTransport: boolean
}

export type RunLaunchRuling = {
  agent: string
  reason: string
  useRequestedTransport: boolean
}

export function decideRunLaunch(facts: RunLaunchFacts): RunLaunchRuling {
  // A resumed turn stays with the vendor session that owns the conversation.
  const selected =
    facts.source === 'resume'
      ? {
          agent: facts.agent,
          reason:
            `resumed run ${facts.parent} (turn ${facts.turn}); ` +
            'repository path retargeting not applied because the turn is already bound to its worktree',
        }
      : { agent: facts.agent, reason: facts.reason }
  return {
    ...selected,
    useRequestedTransport:
      facts.source === 'resume' || facts.explicitTransport || facts.envTransport,
  }
}
