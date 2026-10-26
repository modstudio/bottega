// concern: run worker home provisioning and failed-launch cleanup
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Agent } from '../agent/agents.ts'
import { workerHarnessName } from '../agent/worker-launch-env.ts'
import type { McpMode } from '../mcp/mcp-preflight.ts'
import { type McpServerConfig, readMcpConfig } from '../mcp/mcp-probe.ts'
import type { Project } from '../project/projects.ts'
import { trackedRecipeEnvironment } from '../recipe/tracked-recipe.ts'
import { preflightCodexMcpCatalogues } from '../sandbox/codex-mcp-preflight.ts'
import type { CodexMcpScope } from '../sandbox/codex-mcp-scope.ts'
import { scopeGrokReaderMcpHome } from '../sandbox/grok-reader-mcp-home.ts'
import { inspectGrokReaderMcp } from '../sandbox/grok-reader-mcp-inspect.ts'
import {
  mcpConfigReadForRun,
  projectReaderProxyServersForRun,
  type ReaderProxyServer,
} from '../sandbox/mcp-reader-scope.ts'
import {
  probeProjectMcpLaunches,
  projectMcpProbeLaunches,
  RequiredMcpProbeRefusalError,
  requiredMcpProbeDecision,
} from '../sandbox/project-mcp-preflight.ts'
import type { ProjectMcpSelection } from '../sandbox/project-mcp-scope.ts'
import {
  prepareProjectGrokMcpScope,
  prepareSandboxHome,
  type RunSandbox,
  removeNewSandboxHomeAfterFailure,
  workerStateEnvironment,
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

function grokReaderMcpEnabled(harness: string, usingMcp: boolean): boolean {
  return harness === 'grok' && usingMcp
}

export function grokReaderServersForRun(
  agent: Agent,
  usingMcp: boolean,
  writesRepository: boolean,
  treeConfig: Record<string, McpServerConfig>,
  project: Project | null,
  cwd: string,
): Record<string, ReaderProxyServer> | null {
  return projectReaderProxyServersForRun(
    grokReaderMcpEnabled(workerHarnessName(agent), usingMcp),
    writesRepository,
    treeConfig,
    project,
    cwd,
  )
}

export function claimedGrokReaderConfig(
  agent: Agent,
  writesRepository: boolean,
  cwd: string,
  project: Project,
) {
  const treeConfig = readMcpConfig(cwd)
  return {
    treeConfig,
    readerServers: grokReaderServersForRun(agent, true, writesRepository, treeConfig, project, cwd),
  }
}

export function projectMcpServerName(
  connection: { server: string } | null,
  project: Project | null,
): string | null {
  return connection?.server ?? project?.settings.mcpServer ?? project?.name ?? null
}

/** The MCP scope one launch got: the harness selections and the project selection. */
export type WorkerMcpLaunch = {
  codex: CodexMcpScope | null
  grok: Record<string, ReaderProxyServer> | null
  projectSelection: ProjectMcpSelection | null
}

/**
 * Probe each launch the run will actually get. A scoped `--mcp require` refuses
 * only when its required server failed or was not handed over; other failures
 * warn and continue. Without a scoped project server, any failed launch refuses.
 * A refusal raised here carries no failure kind: the run concern decides how a
 * refusal is recorded.
 */
async function refuseRequiredProjectMcpLaunch(input: {
  runNumber: number
  mcpMode: McpMode | null
  projectSelection: ProjectMcpSelection | null
  project: Project | null
  environment: Record<string, string>
}): Promise<void> {
  if (input.mcpMode !== 'require') return
  const failures = await probeProjectMcpLaunches(
    projectMcpProbeLaunches(input.projectSelection),
    input.environment,
  )
  const requiredServer = projectMcpServerName(null, input.project)
  const facts = {
    mode: input.mcpMode,
    project: input.project,
    failures,
    // The required server, resolved the way run.ts resolves it: the project's
    // configured `mcpServer`, or the project's own name by default.
    requiredServer,
    selectedServers: Object.keys(input.projectSelection?.servers ?? {}),
    withheld: input.projectSelection?.withheld ?? [],
  }
  const decision = requiredMcpProbeDecision(facts)
  if (decision.refusal) throw new RequiredMcpProbeRefusalError(decision.refusal)
  for (const failure of decision.unrelatedFailures) {
    console.error(
      `orch: run ${input.runNumber} project MCP server ${failure.server} failed before launch: ${failure.error}; ` +
        `the run continues because --mcp require applies only to ${requiredServer}`,
    )
  }
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
  runId: string,
): Record<string, string> {
  return {
    ...(writesJob && worktree ? trackedRecipeEnvironment(runId) : {}),
    ...(repoJob && worktree ? { BOTTEGA_MAIN_CHECKOUT: worktree.repoRoot } : {}),
  }
}

export async function prepareWorkerHomeLaunch(input: {
  agent: Agent
  sandbox: RunSandbox
  runDir: string
  runNumber: number
  runRecordId: string
  runToken: string
  environment: Record<string, string>
  grokEnvironment: Record<string, string>
  includeStore: boolean
  mcpLaunch: WorkerMcpLaunch
  mcpMode: McpMode | null
  project: Project | null
}) {
  const harness = workerHarnessName(input.agent)
  const hasRunScopedHome = harness === 'codex' || harness === 'grok' || input.sandbox === 'srt'
  const home = hasRunScopedHome
    ? prepareSandboxHome(harness, input.runDir, process.env, input.sandbox)
    : {}
  const grokReaderScope = applyGrokReaderMcpScope(
    harness,
    input.runDir,
    input.sandbox,
    input.mcpLaunch.grok,
  )
  const environment = childEnv(
    input.agent,
    input.runRecordId,
    input.runToken,
    {
      ...input.environment,
      // Repository workers receive run-scoped homes. Resolve the operator's
      // hub store before that HOME replaces the one that owns task state.
      ...(input.includeStore ? workerStateEnvironment(process.env) : {}),
      ...home,
      ...input.grokEnvironment,
      ...grokReaderScope?.environment,
    },
    input.includeStore,
    input.runNumber,
    input.environment,
  )
  const codexMcpCatalogues = await preflightCodexMcpCatalogues(input.mcpLaunch.codex, environment)
  await refuseRequiredProjectMcpLaunch({
    runNumber: input.runNumber,
    mcpMode: input.mcpMode,
    projectSelection: input.mcpLaunch.projectSelection,
    project: input.project,
    environment,
  })
  return {
    codexMcpCatalogues,
    environment,
    hasRunScopedHome,
    sandboxEnvironment: home,
  }
}

/** Apply the one run-home rewrite and launch-environment change for a Grok reader. */
function applyGrokReaderMcpScope(
  harness: string,
  runDir: string,
  sandbox: RunSandbox,
  servers: Record<string, ReaderProxyServer> | null,
) {
  if (harness !== 'grok' || !servers) return null
  return {
    ...scopeGrokReaderMcpHome(runDir, sandbox, servers),
    environment: { GROK_CURSOR_MCPS_ENABLED: '0' },
  }
}

export function prepareClaimedGrokMcpScope(
  input: {
    agent: Agent
    runDir: string
    runDirExisted: boolean
    cwd: string
    project: Project
    config: ReturnType<typeof prepareWorkerMcpConfig> | null
    treeConfig: Record<string, McpServerConfig>
    readerServers: Record<string, ReaderProxyServer> | null
  },
  recordClaim: () => void,
) {
  try {
    const harness = workerHarnessName(input.agent)
    const config = input.config
    const projectRead = mcpConfigReadForRun(input.treeConfig, input.project, input.cwd)
    const projectConfig = projectRead.ok ? projectRead.config : {}
    const readerServers = input.readerServers
    if (config?.error) {
      return {
        config,
        environment: {},
        error: config.error,
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
    const readerScope = applyGrokReaderMcpScope(harness, input.runDir, 'host', readerServers)
    const inspectError =
      readerServers && readerScope
        ? inspectGrokReaderMcp(
            input.agent.bin,
            input.cwd,
            childEnv(
              input.agent,
              undefined,
              undefined,
              {
                ...scope.environment,
                ...readerScope.environment,
                HOME: `${input.runDir}/home`,
              },
              true,
            ),
            readerServers,
            readerScope.configPath,
            readerScope.platformServers,
          )
        : null
    if (harness === 'grok') recordClaim()
    return {
      ...scope,
      environment: {
        ...scope.environment,
        ...readerScope?.environment,
      },
      config,
      error: config?.error ?? inspectError,
      server: input.project.settings.mcpServer ?? input.project.name,
    }
  } catch (error) {
    removeNewSandboxHomeAfterFailure(input.runDir, input.runDirExisted)
    throw error
  }
}
