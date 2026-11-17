/** Decides the executor columns a claimed run records and guards a harness run's pushes. */
import { type McpRequest, storedMcpRequest } from '../mcp/mcp-preflight.ts'
import type { Worktree } from '../worktree/worktree-types.ts'
import { EXTERNAL_EXECUTOR, HARNESS_AGENT, HARNESS_EXECUTOR } from './run-executor.ts'
import { installHarnessPushGuard } from './run-git-guard.ts'

export function executorClaimFacts(
  name: string,
  mcpRequest: McpRequest | undefined,
  transportName: string,
  timeoutMs: number,
) {
  const harness = name === HARNESS_AGENT
  return {
    harness,
    launchColumns: [
      harness ? null : process.pid,
      storedMcpRequest(mcpRequest),
      transportName,
    ] as const,
    identityColumns: [
      harness ? HARNESS_EXECUTOR : EXTERNAL_EXECUTOR,
      null,
      harness ? timeoutMs : null,
    ] as const,
  }
}

export function installExecutorPushGuard(
  harness: boolean,
  worktree: Worktree | null,
  recordId: string,
): void {
  if (harness) installHarnessPushGuard(worktree, recordId)
}
