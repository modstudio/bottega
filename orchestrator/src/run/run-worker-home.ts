// concern: run worker home provisioning and failed-launch cleanup
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Agent } from '../agent/agents.ts'
import { workerHarnessName } from '../agent/worker-launch-env.ts'
import type { McpServerConfig } from '../mcp/mcp-probe.ts'
import type { Project } from '../project/projects.ts'
import { trackedRecipeEnvironment } from '../recipe/tracked-recipe.ts'
import { preflightCodexMcpCatalogues } from '../sandbox/codex-mcp-preflight.ts'
import type { CodexMcpScope } from '../sandbox/codex-mcp-scope.ts'
import { scopeGrokReaderMcpHome } from '../sandbox/grok-reader-mcp-home.ts'
import { inspectGrokReaderMcp } from '../sandbox/grok-reader-mcp-inspect.ts'
import {
  mcpConfigForRun,
  projectReaderProxyServersForRun,
  type ReaderProxyServer,
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

export function codexPrivateTempEnvironment(
  harness: string,
  repoJob: boolean,
  scratchDir: string,
): Record<string, string> {
  if (harness !== 'codex' || repoJob) return {}
  const privateTemp = join(scratchDir, 'tmp')
  mkdirSync(privateTemp, { recursive: true, mode: 0o700 })
  return { TMPDIR: privateTemp, TMP: privateTemp, TEMP: privateTemp }
}

export function grokReaderMcpEnabled(harness: string, usingMcp: boolean): boolean {
  return harness === 'grok' && usingMcp
}

export function projectMcpServerName(
  connection: { server: string } | null,
  project: Project | null,
): string | null {
  return connection?.server ?? project?.settings.mcpServer ?? project?.name ?? null
}

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
  grokReaderServers: Record<string, ReaderProxyServer> | null
  cwd: string
}) {
  const harness = workerHarnessName(input.agent)
  const hasRunScopedHome = harness === 'codex' || harness === 'grok' || input.sandbox === 'srt'
  const home = hasRunScopedHome
    ? prepareSandboxHome(harness, input.runDir, process.env, input.sandbox)
    : {}
  const measurementScope =
    harness === 'grok' && input.grokReaderServers
      ? scopeGrokReaderMcpHome(input.runDir, input.cwd, input.sandbox, input.grokReaderServers)
      : null
  const environment = childEnv(
    input.agent,
    input.runId,
    input.runToken,
    {
      ...input.environment,
      ...home,
      ...input.grokEnvironment,
      ...(measurementScope ? { GROK_CURSOR_MCPS_ENABLED: '0' } : {}),
    },
    input.includeStore,
  )
  const codexMcpCatalogues = await preflightCodexMcpCatalogues(input.codexMcpScope, environment)
  return {
    codexMcpCatalogues,
    environment,
    hasRunScopedHome,
    sandboxEnvironment: home,
    measurementScope,
  }
}

export function prepareClaimedGrokMcpScope(
  input: {
    agent: Agent
    runDir: string
    runDirExisted: boolean
    cwd: string
    project: Project
    writesRepository: boolean
    config: ReturnType<typeof prepareWorkerMcpConfig> | null
    treeConfig: Record<string, McpServerConfig>
  },
  recordClaim: () => void,
) {
  try {
    const harness = workerHarnessName(input.agent)
    const config = input.config
    const projectConfig = mcpConfigForRun(input.treeConfig, input.project)
    const readerServers =
      harness === 'grok'
        ? projectReaderProxyServersForRun(
            true,
            input.writesRepository,
            input.treeConfig,
            input.project,
            input.cwd,
          )
        : null
    if (config?.error) {
      return {
        config,
        measurementScope: null,
        environment: {},
        header: config.header,
        server: input.project.settings.mcpServer ?? input.project.name,
      }
    }
    // This preparation exists only for a requested MCP preflight, and MCP
    // selection always launches on the host because srt blocks its transports.
    const scope = prepareProjectGrokMcpScope(
      harness,
      input.runDir,
      Object.keys(projectConfig),
      input.project.settings.workerMcpServers,
      config?.header ?? null,
      'host',
    )
    const measurementScope =
      harness === 'grok' && readerServers
        ? scopeGrokReaderMcpHome(input.runDir, input.cwd, 'host', readerServers)
        : null
    const inspectError =
      readerServers && measurementScope
        ? inspectGrokReaderMcp(
            input.agent.bin,
            input.cwd,
            childEnv(
              input.agent,
              undefined,
              undefined,
              {
                ...scope.environment,
                HOME: `${input.runDir}/home`,
                GROK_CURSOR_MCPS_ENABLED: '0',
              },
              true,
            ),
            readerServers,
          )
        : null
    if (harness === 'grok') recordClaim()
    return {
      ...scope,
      environment: {
        ...scope.environment,
        ...(readerServers ? { GROK_CURSOR_MCPS_ENABLED: '0' } : {}),
      },
      config:
        config ??
        (inspectError && measurementScope
          ? { ...measurementScope, header: scope.header, error: inspectError }
          : null),
      measurementScope,
      server: input.project.settings.mcpServer ?? input.project.name,
    }
  } catch (error) {
    removeNewSandboxHomeAfterFailure(input.runDir, input.runDirExisted)
    throw error
  }
}
