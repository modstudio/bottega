export type RunLaunchFacts = (
  | { source: 'resume'; parent: string; turn: number; agent: string }
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

function isRunTransportPinned(
  facts: Pick<RunLaunchFacts, 'explicitTransport' | 'envTransport'>,
): boolean {
  return facts.explicitTransport || facts.envTransport
}

export function runTransportPin(explicit?: string | null, environment?: string) {
  return classifyTransportPin(explicit, environment)
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
    useRequestedTransport: facts.source === 'resume' || isRunTransportPinned(facts),
  }
}

export function resolveRunTransport(opts: {
  transport?: TransportName
  resume?: { kind: 'continue' | 'fresh-session' | 'retry-root'; parent: string }
}): TransportName {
  if (opts.resume?.kind === 'continue' || opts.resume?.kind === 'fresh-session') {
    const inherited = chainTransport(opts.resume.parent)
    if (inherited) return inherited
  }
  return resolveTransportName(opts.transport)
}

import { chainTransport } from '../route/failover.ts'
import {
  classifyTransportPin,
  resolveTransportName,
  type TransportName,
} from '../transport/transport.ts'
