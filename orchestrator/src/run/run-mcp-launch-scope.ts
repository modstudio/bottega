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
} from '../sandbox/project-mcp-scope.ts'
import { codexMcpMode } from './run-mcp-mode.ts'
import { grokReaderServersForRun, projectMcpServerName } from './run-worker-home.ts'

/** Decide one launch's project MCP selection from an already-read tree, register and job shape. */
function launchProjectSelection(
  usingMcp: boolean,
  writesJob: boolean,
  config: Record<string, McpServerConfig>,
  project: Project | null,
  cwd: string,
): ProjectMcpSelection | null {
  return selectProjectMcpServers(codexMcpMode(usingMcp, writesJob), config, project, cwd)
}

/** Decide one launch's project MCP selection alone, reading the tree and the register itself. */
export function workerMcpLaunchSelection(input: {
  usingMcp: boolean
  writesJob: boolean
  callerCwd: string
  cwd: string
}): ProjectMcpSelection | null {
  return launchProjectSelection(
    input.usingMcp,
    input.writesJob,
    readMcpConfig(input.cwd),
    projectAt(input.callerCwd),
    input.cwd,
  )
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
 * The withheld scope line a launch needs, or null. Only a transport that
 * renders the selection itself can leave a worker without the servers it
 * lacks silently: ACP renders the selection. A Codex CLI run reports its own
 * scope in its setup header, and any other CLI renders no selection at all, so
 * neither gets this line.
 */
export function withheldScopeLine(
  transport: string,
  harness: string,
  selection: ProjectMcpSelection | null,
): string | null {
  if (transport !== 'acp') return null
  return projectMcpWithheldLine(harness, selection?.withheld ?? [])
}

/** Decide every MCP scope one launch needs from the tree, the register and the job shape. */
export function workerMcpLaunchScope(input: {
  agent: Agent
  transport: string
  usingMcp: boolean
  writesJob: boolean
  callerCwd: string
  cwd: string
  connection: { server: string } | null
}) {
  const config = readMcpConfig(input.cwd)
  const project = projectAt(input.callerCwd)
  const projectSelection = launchProjectSelection(
    input.usingMcp,
    input.writesJob,
    config,
    project,
    input.cwd,
  )
  return {
    config,
    codex: codexProjectServersFromSelection(projectSelection, input.agent.name, input.transport),
    grok: grokReaderServersForRun(
      input.agent,
      input.usingMcp,
      input.writesJob,
      config,
      project,
      input.cwd,
    ),
    projectSelection,
    serverName: projectMcpServerName(input.connection, project),
    allowlist: mcpConfigAllowlist(config),
  }
}
