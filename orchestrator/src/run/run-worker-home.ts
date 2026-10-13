// concern: run worker home provisioning and failed-launch cleanup
import type { Agent } from '../agent/agents.ts'
import { type McpServerConfig, readMcpConfig } from '../mcp/mcp-probe.ts'
import type { Project } from '../project/projects.ts'
import { trackedRecipeEnvironment } from '../recipe/tracked-recipe.ts'
import { preflightCodexMcpCatalogues } from '../sandbox/codex-mcp-preflight.ts'
import type { CodexMcpScope } from '../sandbox/codex-mcp-scope.ts'
import { scopeGrokReaderMcpHome } from '../sandbox/grok-reader-mcp-home.ts'
import {
  projectReaderProxyServers,
  projectReaderProxyServersForRun,
} from '../sandbox/mcp-reader-scope.ts'
import {
  prepareProjectGrokMcpScope,
  prepareSandboxHome,
  type RunSandbox,
  removeNewSandboxHomeAfterFailure,
} from '../sandbox/sandbox.ts'
import { prepareWorkerMcpConfig } from '../worktree/worktree-mcp.ts'
import type { Worktree } from '../worktree/worktree-types.ts'
import { childEnv } from './run-process.ts'

/** Give cwd-discovered project MCP configuration only to a repository writer. */
export function prepareClaimedWorkerMcpConfig(input: {
  cwd: string
  checkout: string
  inherited: boolean
  writesRepository: boolean
}): ReturnType<typeof prepareWorkerMcpConfig> | null {
  return input.writesRepository
    ? prepareWorkerMcpConfig(input.cwd, input.checkout, input.inherited)
    : null
}

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
  sandbox: RunSandbox
  runDir: string
  runId: number
  runToken: string
  environment: Record<string, string>
  grokEnvironment: Record<string, string>
  includeStore: boolean
  codexMcpScope: CodexMcpScope | null
  grokReaderScope: readonly [
    boolean,
    boolean,
    Record<string, McpServerConfig>,
    Project | null,
    string,
  ]
}) {
  const harness = input.agent.harness ?? input.agent.name
  const hasRunScopedHome = harness === 'codex' || harness === 'grok' || input.sandbox === 'srt'
  const home = hasRunScopedHome
    ? prepareSandboxHome(harness, input.runDir, process.env, input.sandbox)
    : {}
  const grokReaderServers = projectReaderProxyServersForRun(...input.grokReaderScope)
  if (harness === 'grok' && grokReaderServers) {
    scopeGrokReaderMcpHome(input.runDir, input.sandbox, grokReaderServers)
  }
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
    cwd: string
    project: Project
    inherited: boolean
    writesRepository: boolean
  },
  recordClaim: () => void,
) {
  try {
    const config = prepareClaimedWorkerMcpConfig({
      cwd: input.cwd,
      checkout: input.project.path,
      inherited: input.inherited,
      writesRepository: input.writesRepository,
    })
    const projectConfig = readMcpConfig(input.writesRepository ? input.cwd : input.project.path)
    const readerServers = input.writesRepository
      ? null
      : projectReaderProxyServers(projectConfig, input.project, input.cwd)
    if (config?.error) {
      return {
        config,
        environment: {},
        header: config.header,
        server: input.project.settings.mcpServer ?? input.project.name,
      }
    }
    // This preparation exists only for a requested MCP preflight, and MCP
    // selection always launches on the host because srt blocks its transports.
    const scope = prepareProjectGrokMcpScope(
      input.agent,
      input.runDir,
      Object.keys(projectConfig),
      input.project.settings.workerMcpServers,
      config?.header ?? null,
      'host',
    )
    if (input.agent === 'grok' && readerServers) {
      scopeGrokReaderMcpHome(input.runDir, 'host', readerServers)
    }
    if (input.agent === 'grok') recordClaim()
    return {
      ...scope,
      config,
      server: input.project.settings.mcpServer ?? input.project.name,
    }
  } catch (error) {
    removeNewSandboxHomeAfterFailure(input.runDir, input.runDirExisted)
    throw error
  }
}
