/** Renders one run's project MCP selection into the ACP session's server entries. */
import type * as acp from '@agentclientprotocol/sdk'
import type { ProjectMcpSelection } from '../sandbox/project-mcp-scope.ts'

/** Render the run's project MCP selection to ACP entries; no env or header values cross. */
export function acpProjectMcpServers(
  selection: ProjectMcpSelection | null | undefined,
): acp.McpServer[] {
  if (!selection) return []
  return Object.entries(selection.servers).map(([name, server]) =>
    'url' in server
      ? { type: 'http' as const, name, url: server.url, headers: [] }
      : { name, command: server.command, args: server.args, env: [] },
  )
}
