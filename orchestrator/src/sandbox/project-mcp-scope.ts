// concern: project-mcp-scope
/**
 * Names the project MCP servers one run attaches and how. Harness-neutral: it
 * must not know argv, transports, or credentials.
 */
import { isAbsolute, resolve } from 'node:path'
import {
  disabledProjectMcpServers,
  type McpConfigReadResult,
  type McpServerConfig,
} from '../mcp/mcp-probe.ts'
import {
  mcpConfigReadForRun,
  projectReaderProxyServers,
  READER_PLATFORM_MCP_SERVERS,
  type ReaderProxyServer,
} from './mcp-reader-scope.ts'

/**
 * The platform's own MCP identities. A project configuration never occupies
 * them: a project server named like the worker channel could shadow it.
 */
function withoutPlatformServers(read: McpConfigReadResult): McpConfigReadResult {
  if (!read.ok) return read
  const platform = new Set<string>(READER_PLATFORM_MCP_SERVERS)
  return {
    ...read,
    config: Object.fromEntries(Object.entries(read.config).filter(([name]) => !platform.has(name))),
  }
}

/** A project server launchable without inline credentials: a command or a url. */
export type ProjectMcpServer = { command: string; args: string[]; cwd: string } | { url: string }

export type ProjectMcpProject = {
  name: string
  path: string
  settings: { workerMcpServers?: string[]; mcpServer?: string }
}

/** Which project servers attach to one run, and how a harness must reach them. */
export type ProjectMcpSelection =
  | { kind: 'reader'; servers: Record<string, ReaderProxyServer>; withheld: string[] }
  | { kind: 'direct'; servers: Record<string, ProjectMcpServer>; withheld: string[] }

/** Select project MCP launch definitions that are safe to expose without inline credentials. */
function selectDirectProjectMcpServers(
  read: McpConfigReadResult,
  allowed: string[] | undefined,
  cwd: string,
): Extract<ProjectMcpSelection, { kind: 'direct' }> {
  const projectRead = withoutPlatformServers(read)
  const projectServers = projectRead.ok ? projectRead.config : {}
  const disabled = new Set(disabledProjectMcpServers(Object.keys(projectServers), allowed))
  const servers: Record<string, ProjectMcpServer> = {}
  const withheld: string[] = []
  for (const [name, entry] of Object.entries(projectServers)) {
    if (disabled.has(name)) continue
    if (
      Object.keys(entry.env ?? {}).length ||
      Object.keys(entry.headers ?? {}).length ||
      entry.headersHelper
    ) {
      withheld.push(name)
    } else if (entry.url) {
      servers[name] = { url: entry.url }
    } else if (entry.command) {
      const command =
        entry.command.includes('/') && !isAbsolute(entry.command)
          ? resolve(cwd, entry.command)
          : entry.command
      servers[name] = { command, args: entry.args ?? [], cwd }
    } else {
      withheld.push(name)
    }
  }
  return { kind: 'direct', servers, withheld }
}

/**
 * Decide which project servers one run attaches. A reading run reaches them
 * through the credential-free reader proxy; a writing run attaches them
 * directly; the run's allowlist applies to both.
 */
export function selectProjectMcpServers(
  mcp: false | 'reader' | 'writer',
  treeConfig: Record<string, McpServerConfig>,
  project: ProjectMcpProject | null,
  cwd: string,
): ProjectMcpSelection | null {
  if (mcp === false) return null
  const read = mcpConfigReadForRun(treeConfig, project, cwd)
  if (mcp === 'writer')
    return selectDirectProjectMcpServers(read, project?.settings.workerMcpServers, cwd)
  return {
    kind: 'reader',
    servers: projectReaderProxyServers(withoutPlatformServers(read), project, cwd),
    withheld: [],
  }
}

/** The visible reason one harness does not have a withheld project server. */
export function projectMcpWithheldLine(harness: string, withheld: string[]): string | null {
  if (!withheld.length) return null
  return `MCP scope: ${harness} withheld ${withheld.join(', ')} (inline env/headers, a headersHelper, or no launch definition); writing workers cannot receive these; run as a reader through the proxy, or declare the server without them`
}

/**
 * Append an already-rendered scope line to a setup header. Whether a harness
 * needs the line is its caller's decision, not this module's.
 */
export function mergeMcpSetupHeader(header: string | null, line: string | null): string | null {
  if (!line) return header
  return header ? `${header}\n${line}` : line
}
