// concern: reader MCP server scope
/** Selects the project MCP servers a reading harness reaches through the shared proxy. */

import { bottegaEntryArgv } from '../../../shared/self-spawn.ts'
import { disabledProjectMcpServers, type McpServerConfig, readMcpConfig } from '../mcp/mcp-probe.ts'

export type ReaderProxyServer = {
  command: string
  args: string[]
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
  const disabled = new Set(
    disabledProjectMcpServers(Object.keys(config), project.settings.workerMcpServers),
  )
  const names = new Set([
    ...Object.keys(config).filter((name) => !disabled.has(name)),
    project.settings.mcpServer ?? project.name,
  ])
  const [command, ...baseArgs] = bottegaEntryArgv('mcp-reader-proxy')
  return Object.fromEntries(
    [...names].map((server) => [
      server,
      { command, args: [...baseArgs, project.name, server, cwd] },
    ]),
  )
}

/** Resolve ignored checkout configuration before selecting a reading run's proxy servers. */
export function projectReaderProxyServersForRun(
  enabled: boolean,
  treeConfig: Record<string, McpServerConfig>,
  project: {
    name: string
    path: string
    settings: { workerMcpServers?: string[]; mcpServer?: string }
  } | null,
  cwd: string,
): Record<string, ReaderProxyServer> | null {
  if (!enabled) return null
  const config =
    Object.keys(treeConfig).length || !project ? treeConfig : readMcpConfig(project.path)
  return projectReaderProxyServers(config, project, cwd)
}
