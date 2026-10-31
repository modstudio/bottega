// concern: reader MCP server scope
/** Selects the project MCP servers a reading harness reaches through the shared proxy. */

import { isAbsolute, resolve } from 'node:path'
import { MCP_SERVER_NAME, WORKER_MCP_SERVER_NAME } from '../../../shared/brand.ts'
import { bottegaEntryArgv } from '../../../shared/self-spawn.ts'
import {
  bottegaMcpBinary,
  disabledProjectMcpServers,
  type McpConfigReadResult,
  type McpServerConfig,
  readMcpConfigResult,
  resolveMcpServerLaunchFromRead,
} from '../mcp/mcp-probe.ts'

export type ReaderProxyServer = {
  command: string
  args: string[]
}

/** One project server shape the Grok run-home renderer accepts. */
export type GrokMcpServerEntry =
  | ReaderProxyServer
  | { command: string; args: string[]; cwd: string }
  | { url: string }

/** Build credential-free proxy launches for already-selected server names. */
export function projectProxyServers(
  names: readonly string[],
  policy: 'reader' | 'writer',
  projectName: string,
  cwd: string,
): Record<string, ReaderProxyServer> {
  const argv = bottegaEntryArgv('mcp-reader-proxy')
  const command = argv[0]!
  const baseArgs = argv.slice(1)
  return Object.fromEntries(
    names.map((server) => [
      server,
      { command, args: [...baseArgs, policy, projectName, server, cwd] },
    ]),
  )
}

export type ProjectMcpWithheld = {
  name: string
  reason: string
  advice?: string
  remedy?: string
}

export const PROJECT_RELATIVE_NO_TREE_REASON =
  'its command is project-relative and this run has no project tree'

export const PROJECT_RELATIVE_NO_TREE_REMEDY =
  "the server's command in .mcp.json must be a bare name or an absolute path, because the reader proxy resolves a project-relative command against the run tree; or dispatch a job that gets a project tree"

/** Withhold a project-relative stdio command when the run has no project checkout. */
export function withholdProjectRelativeStdioServer(
  server: { command?: string; url?: string },
  hasProjectTree: boolean,
): boolean {
  return !hasProjectTree && isProjectRelativeStdioServer(server)
}

/** Whether a stdio launch resolves a relative path beneath its launch cwd. */
export function isProjectRelativeStdioServer(server: { command?: string; url?: string }): boolean {
  if (server.url || !server.command) return false
  return server.command.includes('/') && !isAbsolute(server.command)
}

export const READER_PLATFORM_MCP_SERVERS = [MCP_SERVER_NAME, WORKER_MCP_SERVER_NAME] as const

/** Build the only MCP table a Grok reader's run home may expose. */
export function grokReaderMcpServerTable(
  userServers: Record<string, unknown> | undefined,
  proxies: Record<string, GrokMcpServerEntry>,
): Record<string, unknown> {
  return {
    ...(userServers?.[MCP_SERVER_NAME] ? { [MCP_SERVER_NAME]: userServers[MCP_SERVER_NAME] } : {}),
    ...Object.fromEntries(
      Object.entries(proxies)
        .filter(
          ([name]) =>
            !READER_PLATFORM_MCP_SERVERS.includes(
              name as (typeof READER_PLATFORM_MCP_SERVERS)[number],
            ),
        )
        .map(([name, server]) => [name, { ...server, enabled: true }]),
    ),
  }
}

/**
 * Select project server names without consulting the process installation.
 *
 * A configured primary stays even when the allow-list would disable it. A
 * primary the resolution serves without a tree entry keeps its place too:
 * bottega's own MCP server is installed by the platform, and its proxy resolves
 * the built-in launch, so it needs no `.mcp.json` entry. Any other
 * unconfigured primary is not a project server at all — a proxy synthesized for
 * a name nothing starts exits at start — so it joins only when the
 * configuration names it. A launch file that could not be read names no server,
 * so the platform's own name is not served either.
 */
export function projectReaderServerNames(
  read: McpConfigReadResult,
  allowed: string[] | undefined,
  primary: string,
  bottegaBinary: string,
): string[] {
  const configuredNames = read.ok ? Object.keys(read.config) : []
  const disabled = new Set(disabledProjectMcpServers(configuredNames, allowed))
  const kept = configuredNames.filter((name) => !disabled.has(name))
  const primaryServed = resolveMcpServerLaunchFromRead(read, primary, bottegaBinary) !== null
  return [...new Set(primaryServed ? [...kept, primary] : kept)]
}

/**
 * The launch file one run resolves against, with the outcome of reading the
 * checkout's copy preserved: the run tree's own configuration when it names a
 * server, otherwise the registered checkout's `.mcp.json`.
 */
export function mcpConfigReadForRun(
  treeConfig: Record<string, McpServerConfig>,
  project: { path: string } | null,
  cwd: string,
): McpConfigReadResult {
  if (Object.keys(treeConfig).length || !project) {
    return { ok: true, path: resolve(cwd, '.mcp.json'), config: treeConfig }
  }
  return readMcpConfigResult(project.path)
}

/** Build the credential-free proxy definitions shared by every reading harness. */
export function projectReaderProxyServers(
  read: McpConfigReadResult,
  project: {
    name: string
    settings: { workerMcpServers?: string[]; mcpServer?: string }
  } | null,
  cwd: string,
  hasProjectTree: boolean,
): { servers: Record<string, ReaderProxyServer>; withheld: ProjectMcpWithheld[] } {
  if (!project) return { servers: {}, withheld: [] }
  const names = projectReaderServerNames(
    read,
    project.settings.workerMcpServers,
    project.settings.mcpServer ?? project.name,
    bottegaMcpBinary(),
  )
  const config = read.ok ? read.config : {}
  const withheld: ProjectMcpWithheld[] = []
  const kept: string[] = []
  for (const name of names) {
    if (withholdProjectRelativeStdioServer(config[name] ?? {}, hasProjectTree)) {
      withheld.push({
        name,
        reason: PROJECT_RELATIVE_NO_TREE_REASON,
        remedy: PROJECT_RELATIVE_NO_TREE_REMEDY,
      })
    } else {
      kept.push(name)
    }
  }
  return {
    servers: projectProxyServers(kept, 'reader', project.name, cwd),
    withheld,
  }
}

/** Resolve ignored checkout configuration before selecting a reading run's proxy servers. */
export function projectReaderProxyServersForRun(
  enabled: boolean,
  writesRepository: boolean,
  treeConfig: Record<string, McpServerConfig>,
  project: {
    name: string
    path: string
    settings: { workerMcpServers?: string[]; mcpServer?: string }
  } | null,
  cwd: string,
  hasProjectTree: boolean,
): Record<string, ReaderProxyServer> | null {
  if (!enabled || writesRepository) return null
  const read = mcpConfigReadForRun(treeConfig, project, cwd)
  return projectReaderProxyServers(read, project, cwd, hasProjectTree).servers
}
