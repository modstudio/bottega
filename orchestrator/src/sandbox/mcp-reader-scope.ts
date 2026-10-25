// concern: reader MCP server scope
/** Selects the project MCP servers a reading harness reaches through the shared proxy. */

import { MCP_SERVER_NAME, WORKER_MCP_SERVER_NAME } from '../../../shared/brand.ts'
import { bottegaEntryArgv } from '../../../shared/self-spawn.ts'
import {
  bottegaMcpBinary,
  disabledProjectMcpServers,
  type McpServerConfig,
  readMcpConfig,
  resolveMcpServerLaunch,
} from '../mcp/mcp-probe.ts'

export type ReaderProxyServer = {
  command: string
  args: string[]
}

export const READER_PLATFORM_MCP_SERVERS = [MCP_SERVER_NAME, WORKER_MCP_SERVER_NAME] as const

/** Build the only MCP table a Grok reader's run home may expose. */
export function grokReaderMcpServerTable(
  userServers: Record<string, unknown> | undefined,
  proxies: Record<string, ReaderProxyServer>,
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
 * Select project server names without consulting the filesystem or process installation.
 *
 * A configured primary stays even when the allow-list would disable it. A
 * primary the resolution serves without a tree entry keeps its place too:
 * bottega's own MCP server is installed by the platform, and its proxy resolves
 * the built-in launch, so it needs no `.mcp.json` entry. Any other
 * unconfigured primary is not a project server at all — a proxy synthesized for
 * a name nothing starts exits at start — so it joins only when the
 * configuration names it.
 */
export function projectReaderServerNames(
  config: Record<string, McpServerConfig>,
  allowed: string[] | undefined,
  primary: string,
  bottegaBinary: string,
): string[] {
  const configuredNames = Object.keys(config)
  const disabled = new Set(disabledProjectMcpServers(configuredNames, allowed))
  const kept = configuredNames.filter((name) => !disabled.has(name))
  const primaryServed = resolveMcpServerLaunch(config, primary, bottegaBinary) !== null
  return [...new Set(primaryServed ? [...kept, primary] : kept)]
}

/** Resolve the checkout fallback used by every harness for one run. */
export function mcpConfigForRun(
  treeConfig: Record<string, McpServerConfig>,
  project: { path: string } | null,
): Record<string, McpServerConfig> {
  return Object.keys(treeConfig).length || !project ? treeConfig : readMcpConfig(project.path)
}

/** Build the credential-free proxy definitions shared by every reading harness. */
export function projectReaderProxyServers(
  config: Record<string, McpServerConfig>,
  project: {
    name: string
    settings: { workerMcpServers?: string[]; mcpServer?: string }
  } | null,
  cwd: string,
): Record<string, ReaderProxyServer> {
  if (!project) return {}
  const names = projectReaderServerNames(
    config,
    project.settings.workerMcpServers,
    project.settings.mcpServer ?? project.name,
    bottegaMcpBinary(),
  )
  const argv = bottegaEntryArgv('mcp-reader-proxy')
  const command = argv[0]!
  const baseArgs = argv.slice(1)
  return Object.fromEntries(
    names.map((server) => [server, { command, args: [...baseArgs, project.name, server, cwd] }]),
  )
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
): Record<string, ReaderProxyServer> | null {
  if (!enabled || writesRepository) return null
  const config = mcpConfigForRun(treeConfig, project)
  return projectReaderProxyServers(config, project, cwd)
}
