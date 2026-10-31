// concern: run-mcp-launch-scope
/** The MCP servers one worker launch attaches, before any harness renders them. */
import type { Agent } from '../agent/agents.ts'
import { type McpServerConfig, mcpConfigAllowlist, readMcpConfig } from '../mcp/mcp-probe.ts'
import { type Project, projectAt } from '../project/projects.ts'
import { codexProjectServersFromSelection } from '../sandbox/codex-mcp-scope.ts'
import {
  type ProjectMcpSelection,
  projectMcpWithheldLine,
  selectProjectMcpServers,
  type WriterProxyDecision,
} from '../sandbox/project-mcp-scope.ts'
import { codexMcpMode } from './run-mcp-mode.ts'
import { grokReaderServersForRun, projectMcpServerName } from './run-worker-home.ts'

const PROJECT_MCP_UNSUPPORTED_WRITER_ADVICE =
  'only codex and grok CLI writers receive proxied project servers; use one of those launches or declare the server without inline credentials'

export const PROJECT_MCP_ACP_WRITER_ADVICE =
  'ACP writers do not receive proxied project servers yet'

/** Resolve harness and transport facts into the sandbox's writer-proxy decision. */
export function writerProxyRoute(harness: string, transport: string): WriterProxyDecision {
  if (transport === 'cli' && (harness === 'codex' || harness === 'grok')) {
    return { kind: 'proxy' }
  }
  if (transport === 'acp') return { kind: 'withhold', advice: PROJECT_MCP_ACP_WRITER_ADVICE }
  return { kind: 'withhold', advice: PROJECT_MCP_UNSUPPORTED_WRITER_ADVICE }
}

/** Decide one launch's project MCP selection from an already-read tree, register and job shape. */
function launchProjectSelection(
  usingMcp: boolean,
  writesJob: boolean,
  config: Record<string, McpServerConfig>,
  project: Project | null,
  cwd: string,
  hasProjectTree: boolean,
  writerProxy: WriterProxyDecision,
): ProjectMcpSelection | null {
  return selectProjectMcpServers(
    codexMcpMode(usingMcp, writesJob),
    config,
    project,
    cwd,
    hasProjectTree,
    writerProxy,
  )
}

/**
 * Read the tree and the register once, then decide one launch's project MCP
 * selection. Every caller shares this one read-and-decide path.
 */
function launchSelectionFacts(input: {
  usingMcp: boolean
  writesJob: boolean
  hasProjectTree: boolean
  callerCwd: string
  cwd: string
  writerProxy: WriterProxyDecision
}): {
  config: Record<string, McpServerConfig>
  project: Project | null
  selection: ProjectMcpSelection | null
} {
  const config = readMcpConfig(input.cwd)
  const project = projectAt(input.callerCwd)
  return {
    config,
    project,
    selection: launchProjectSelection(
      input.usingMcp,
      input.writesJob,
      config,
      project,
      input.cwd,
      input.hasProjectTree,
      input.writerProxy,
    ),
  }
}

/** Decide one launch's project MCP selection alone, reading the tree and the register itself. */
export function workerMcpLaunchSelection(input: {
  usingMcp: boolean
  writesJob: boolean
  hasProjectTree: boolean
  callerCwd: string
  cwd: string
  writerProxy: WriterProxyDecision
}): ProjectMcpSelection | null {
  return launchSelectionFacts(input).selection
}

/**
 * The project selection a launch attaches. A run whose MCP connection was
 * downgraded after the selection was decided attaches none, so a stale
 * selection never reaches a harness that renders it without re-gating.
 */
export function projectSelectionForLaunch(
  usingMcp: boolean,
  selection: ProjectMcpSelection | null,
): ProjectMcpSelection | null {
  return usingMcp ? selection : null
}

/**
 * The withheld scope line a launch needs, or null. Only a transport or harness
 * that renders the selection itself can leave a worker without the servers it
 * lacks silently: ACP renders the selection, and Grok CLI rewrites its run
 * home from the reader selection. A Codex CLI run reports its own scope in its
 * setup header, and any other CLI renders no selection at all, so neither gets
 * this line.
 */
export function withheldScopeLine(
  transport: string,
  harness: string,
  selection: ProjectMcpSelection | null,
): string | null {
  if (transport !== 'acp' && harness !== 'grok') return null
  return projectMcpWithheldLine(harness, selection?.withheld ?? [])
}

/** Decide every MCP scope one launch needs from the tree, the register and the job shape. */
export function workerMcpLaunchScope(input: {
  agent: Agent
  transport: string
  usingMcp: boolean
  writesJob: boolean
  hasProjectTree: boolean
  callerCwd: string
  cwd: string
  connection: { server: string } | null
}) {
  const harness = input.agent.harness ?? input.agent.name
  const writerProxy = writerProxyRoute(harness, input.transport)
  const {
    config,
    project,
    selection: projectSelection,
  } = launchSelectionFacts({
    ...input,
    writerProxy,
  })
  return {
    config,
    codex: codexProjectServersFromSelection(projectSelection, input.agent.name, input.transport),
    grok:
      grokReaderServersForRun(
        input.agent,
        input.usingMcp,
        input.writesJob,
        config,
        project,
        input.cwd,
        input.hasProjectTree,
      ) ??
      (writerProxy.kind === 'proxy' && harness === 'grok' && input.writesJob
        ? (projectSelection?.servers ?? null)
        : null),
    projectSelection,
    serverName: projectMcpServerName(input.connection, project),
    allowlist: mcpConfigAllowlist(config),
  }
}
