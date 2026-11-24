/** Renders the ACP session's worker stdio channel and run project MCP selection. */
import type * as acp from '@agentclientprotocol/sdk'
import { WORKER_MCP_SERVER_NAME } from '../../../shared/brand.ts'
import { CHECKOUT_CLI_BINARY_ENV } from '../../../shared/install-root.ts'
import { bottegaEntryArgv } from '../../../shared/self-spawn.ts'
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

/** Render the stdio ask extension and its explicitly forwarded environment. */
export function acpStdioWorkerChannel(env: Record<string, string | undefined>): acp.McpServer[] {
  const [command, ...args] = bottegaEntryArgv('ask-server')
  return [
    {
      name: WORKER_MCP_SERVER_NAME,
      command: command!,
      args,
      env: [
        'BOTTEGA_ASK_URL',
        'BOTTEGA_RUN_ID',
        'BOTTEGA_RUN_TOKEN',
        'BOTTEGA_ORCHESTRATOR_DB',
        CHECKOUT_CLI_BINARY_ENV,
        'HTTP_PROXY',
        'http_proxy',
        'NO_PROXY',
        'no_proxy',
      ].flatMap((name) => (env[name] ? [{ name, value: env[name]! }] : [])),
    },
  ]
}
