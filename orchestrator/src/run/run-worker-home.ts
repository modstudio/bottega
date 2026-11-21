// concern: run worker home provisioning and failed-launch cleanup
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
  type ProjectMcpServerEntry,
  projectReaderProxyServersForRun,
  type ReaderProxyServer,
} from '../sandbox/mcp-reader-scope.ts'
import {
  probeProjectMcpLaunches,
  projectMcpProbeLaunches,
  RequiredMcpProbeRefusalError,
  requiredMcpProbeDecision,
} from '../sandbox/project-mcp-preflight.ts'
import type { HeaderMismatchFinding, ProjectMcpSelection } from '../sandbox/project-mcp-scope.ts'
import {
  prepareProjectGrokMcpScope,
  prepareSandboxHome,
  type RunSandbox,
  removeNewSandboxHomeAfterFailure,
} from '../sandbox/sandbox.ts'
import {
  workerSandboxEnvironment,
  workerStateEnvironment,
} from '../sandbox/worker-sandbox-environment.ts'
import { prepareWorkerMcpConfig } from '../worktree/worktree-mcp.ts'
import type { Worktree } from '../worktree/worktree-types.ts'
import { childEnv } from './run-process.ts'

export function readOnlyRunTempEnvironment(
  privateTemp: string | undefined,
): Record<string, string> {
  if (!privateTemp) return {}
  return {
    TMPDIR: privateTemp,
    TMP: privateTemp,
    TEMP: privateTemp,
    CLAUDE_CODE_TMPDIR: privateTemp,
  }
}

export function runTemp(runtimeDir: string, directory: string | undefined) {
  return { runtimeDir, directory, environment: readOnlyRunTempEnvironment(directory) }
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
  hasProjectTree: boolean,
): Record<string, ReaderProxyServer> | null {
  return projectReaderProxyServersForRun(
    grokReaderMcpEnabled(workerHarnessName(agent), usingMcp),
    writesRepository,
    treeConfig,
    project,
    cwd,
    hasProjectTree,
  )
}

export function claimedGrokReaderConfig(
  agent: Agent,
  writesRepository: boolean,
  cwd: string,
  project: Project,
  hasProjectTree: boolean,
) {
  const treeConfig = readMcpConfig(cwd)
  return {
    treeConfig,
    readerServers: grokReaderServersForRun(
      agent,
      true,
      writesRepository,
      treeConfig,
      project,
      cwd,
      hasProjectTree,
    ),
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
  grok: Record<string, ProjectMcpServerEntry> | null
  projectSelection: ProjectMcpSelection | null
  headerMismatches: HeaderMismatchFinding[]
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
  headerMismatches: readonly HeaderMismatchFinding[]
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
    headerMismatches: input.headerMismatches,
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

export function runScopedHome(harness: string, sandbox: RunSandbox): boolean {
  return harness === 'codex' || harness === 'grok' || sandbox === 'srt'
}

export function workerChildEnvironment(input: {
  agent: Agent
  sandbox: RunSandbox
  runRecordId: string
  runToken: string
  runNumber: number
  environment: Record<string, string>
  stateEnvironment: Record<string, string | undefined>
  includeStore: boolean
  endpointEnvironment?: Record<string, string>
}): Record<string, string> {
  // Resolve shared state before a run-scoped HOME replaces the operator HOME,
  // then let childEnv add the worker markers used by caller classification.
  return childEnv(
    input.agent,
    input.runRecordId,
    input.runToken,
    {
      ...input.environment,
      ...(input.includeStore ? workerStateEnvironment(input.stateEnvironment) : {}),
      ...(input.sandbox === 'srt' ? workerSandboxEnvironment() : {}),
    },
    input.includeStore,
    input.runNumber,
    input.endpointEnvironment ?? input.environment,
  )
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
  const hasRunScopedHome = runScopedHome(harness, input.sandbox)
  const home = hasRunScopedHome
    ? prepareSandboxHome(harness, input.runDir, process.env, input.sandbox)
    : {}
  const grokReaderScope = applyGrokReaderMcpScope(
    harness,
    input.runDir,
    input.sandbox,
    input.mcpLaunch.grok,
  )
  const environment = workerChildEnvironment({
    agent: input.agent,
    sandbox: input.sandbox,
    runRecordId: input.runRecordId,
    runToken: input.runToken,
    runNumber: input.runNumber,
    environment: {
      ...input.environment,
      ...home,
      ...input.grokEnvironment,
      ...grokReaderScope?.environment,
    },
    stateEnvironment: process.env,
    includeStore: input.includeStore,
    endpointEnvironment: input.environment,
  })
  const codexMcpCatalogues = await preflightCodexMcpCatalogues(input.mcpLaunch.codex, environment)
  await refuseRequiredProjectMcpLaunch({
    runNumber: input.runNumber,
    mcpMode: input.mcpMode,
    projectSelection: input.mcpLaunch.projectSelection,
    headerMismatches: input.mcpLaunch.headerMismatches,
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
  servers: Record<string, ProjectMcpServerEntry> | null,
) {
  if (harness !== 'grok' || !servers) return null
  return {
    ...scopeGrokReaderMcpHome(runDir, sandbox, servers),
    environment: { GROK_CURSOR_MCPS_ENABLED: '0' },
  }
}

export function prepareClaimedGrokMcpScope(input: {
  agent: Agent
  runDir: string
  runDirExisted: boolean
  cwd: string
  project: Project
  config: ReturnType<typeof prepareWorkerMcpConfig> | null
  treeConfig: Record<string, McpServerConfig>
  readerServers: Record<string, ReaderProxyServer> | null
}) {
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
