// concern: run worker home provisioning and failed-launch cleanup
import type { Agent } from '../agent/agents.ts'
import { trackedRecipeEnvironment } from '../recipe/tracked-recipe.ts'
import { preflightCodexMcpCatalogues } from '../sandbox/codex-mcp-preflight.ts'
import type { CodexMcpScope } from '../sandbox/codex-mcp-scope.ts'
import {
  prepareProjectGrokMcpScope,
  prepareSandboxHome,
  removeNewSandboxHomeAfterFailure,
} from '../sandbox/sandbox.ts'
import type { Worktree } from '../worktree/worktree-types.ts'
import { childEnv } from './run-process.ts'

/** Build environment only from the recipe that created this recorded tree. */
export function trackedWorkerEnvironment(
  repoJob: boolean,
  writesJob: boolean,
  worktree: Worktree | null,
  runId: number,
): Record<string, string> {
  return {
    ...(writesJob && worktree ? trackedRecipeEnvironment(runId) : {}),
    ...(repoJob && worktree ? { ORCH_MAIN_CHECKOUT: worktree.repoRoot } : {}),
  }
}

export async function prepareWorkerHomeLaunch(input: {
  agent: Agent
  harness: string
  sandboxProfile: boolean
  runDir: string
  runId: number
  runToken: string
  environment: Record<string, string>
  grokEnvironment: Record<string, string>
  includeStore: boolean
  codexMcpScope: CodexMcpScope | null
}) {
  const hasRunScopedHome =
    input.harness === 'codex' || input.harness === 'grok' || input.sandboxProfile
  const home = hasRunScopedHome ? prepareSandboxHome(input.harness, input.runDir) : {}
  const environment = childEnv(
    input.agent,
    input.runId,
    input.runToken,
    { ...input.environment, ...home, ...input.grokEnvironment },
    input.includeStore,
  )
  const codexMcpCatalogues = await preflightCodexMcpCatalogues(input.codexMcpScope, environment)
  return { codexMcpCatalogues, environment, hasRunScopedHome, sandboxEnvironment: home }
}

export function prepareClaimedGrokMcpScope(
  input: {
    agent: string
    runDir: string
    runDirExisted: boolean
    names: string[]
    allowed: string[] | undefined
    header: string | null
  },
  recordClaim: () => void,
) {
  try {
    const scope = prepareProjectGrokMcpScope(
      input.agent,
      input.runDir,
      input.names,
      input.allowed,
      input.header,
    )
    if (input.agent === 'grok') recordClaim()
    return scope
  } catch (error) {
    removeNewSandboxHomeAfterFailure(input.runDir, input.runDirExisted)
    throw error
  }
}
