// concern: mcp-tool-list
/**
 * Lists every tools/list page through the standard MCP transports. The caller
 * owns scope policy and interpretation of the returned pages.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const MCP_TOOL_LIST_TIMEOUT_MS = 8_000

export type McpToolPage = { tools: { name: string }[] }

export type McpToolListLaunch = {
  command?: string
  args?: string[]
  cwd?: string
  url?: string
}

/** Follow tools/list cursors to exhaustion using one initialized MCP session. */
export async function listMcpToolPages(
  launch: McpToolListLaunch,
  env: Record<string, string>,
): Promise<McpToolPage[]> {
  const transport = launch.url
    ? new StreamableHTTPClientTransport(new URL(launch.url))
    : launch.command
      ? new StdioClientTransport({
          command: launch.command,
          args: launch.args ?? [],
          cwd: launch.cwd,
          env,
          stderr: 'pipe',
        })
      : null
  if (!transport) throw new Error('MCP server has no stored launch definition')

  const client = new Client({ name: 'orch-mcp-preflight', version: '0.1.0' })
  const request = {
    signal: AbortSignal.timeout(MCP_TOOL_LIST_TIMEOUT_MS),
    timeout: MCP_TOOL_LIST_TIMEOUT_MS,
  }
  try {
    await client.connect(transport, request)
    const pages: McpToolPage[] = []
    let cursor: string | undefined
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined, request)
      pages.push({ tools: page.tools.map(({ name }) => ({ name })) })
      cursor = page.nextCursor
    } while (cursor)
    return pages
  } finally {
    await client.close().catch(() => undefined)
  }
}
