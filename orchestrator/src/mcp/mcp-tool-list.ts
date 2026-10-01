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
  headers?: Record<string, string>
  env?: Record<string, string>
}

type McpToolResult = {
  isError?: boolean
  content?: unknown
  structuredContent?: unknown
}

export class McpToolCallError extends Error {
  readonly structuredContent: unknown

  constructor(message: string, structuredContent: unknown) {
    super(message)
    this.name = 'McpToolCallError'
    this.structuredContent = structuredContent
  }
}

export function unwrapMcpToolResult(result: McpToolResult, name: string): unknown {
  const content = Array.isArray(result.content)
    ? (result.content as { type?: string; text?: string }[])
    : []
  if (result.isError) {
    const text = content
      .filter(
        (item): item is { type: 'text'; text: string } =>
          item.type === 'text' && typeof item.text === 'string',
      )
      .map((item) => item.text)
      .join('; ')
    throw new McpToolCallError(text || `${name} returned an error`, result.structuredContent)
  }
  if (result.structuredContent !== undefined) return result.structuredContent
  const text = content.find(
    (item): item is { type: 'text'; text: string } =>
      item.type === 'text' && typeof item.text === 'string',
  )?.text
  if (text === undefined) return result
  try {
    return JSON.parse(text)
  } catch {
    return { text }
  }
}

async function withMcpClient<T>(
  launch: McpToolListLaunch,
  env: Record<string, string>,
  use: (client: Client, request: { signal: AbortSignal; timeout: number }) => Promise<T>,
): Promise<T> {
  const transport = launch.url
    ? new StreamableHTTPClientTransport(new URL(launch.url), {
        requestInit: { headers: launch.headers },
      })
    : launch.command
      ? new StdioClientTransport({
          command: launch.command,
          args: launch.args ?? [],
          cwd: launch.cwd,
          env: { ...env, ...launch.env },
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
    return await use(client, request)
  } finally {
    await client.close().catch(() => undefined)
  }
}

/** Follow tools/list cursors to exhaustion using one initialized MCP session. */
export async function listMcpToolPages(
  launch: McpToolListLaunch,
  env: Record<string, string>,
): Promise<McpToolPage[]> {
  return withMcpClient(launch, env, async (client, request) => {
    const pages: McpToolPage[] = []
    let cursor: string | undefined
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined, request)
      pages.push({ tools: page.tools.map(({ name }) => ({ name })) })
      cursor = page.nextCursor
    } while (cursor)
    return pages
  })
}

/** Call one advertised tool through the same standard MCP transports used by preflight. */
export async function callMcpTool(
  launch: McpToolListLaunch,
  env: Record<string, string>,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  return withMcpClient(launch, env, async (client, request) => {
    const result = await client.callTool({ name, arguments: args }, undefined, request)
    return unwrapMcpToolResult(result as McpToolResult, name)
  })
}
