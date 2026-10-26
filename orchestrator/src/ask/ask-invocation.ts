// concern: the one invocation that writes the store from a worker-classified environment
import type { PublicCommandInvocation } from '../../../shared/commander-public-path.ts'

/**
 * The ask server is the one invocation that writes the store from a worker-classified
 * environment: the escalation channel its worker's question, message and gate rows travel
 * through. It reaches the CLI as its own command name, or through its public path under the
 * MCP surface. The ask concern owns that identity, so the CLI surface only dispatches — and
 * uses this predicate for the one thing the identity decides there, recording a startup
 * failure where the run reads it.
 */
export function isAskServerInvocation(
  argv: readonly string[],
  invocation?: PublicCommandInvocation,
): boolean {
  const ownerPath = invocation?.ownerPath ?? argv
  const publicPath = invocation?.publicPath ?? argv
  return (
    ownerPath[0] === 'ask-server' || (publicPath[0] === 'mcp' && publicPath[1] === 'ask-server')
  )
}
