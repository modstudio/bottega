// concern: mcp-reader-proxy
/** Filters one project MCP server down to tools a reading job may call. */

import type { CallToolResult, Tool } from '@modelcontextprotocol/client'
import { Server } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { projectByName } from '../project/projects.ts'
import { probeSecrets, readMcpConfig, sanitizeProbeError } from './mcp-probe.ts'
import { connectMcpToolClient, type McpToolListLaunch } from './mcp-tool-list.ts'

const MCP_PROXY_TIMEOUT_MS = 8_000

export type ReaderToolDecision = {
  name: string
  readOnlyHint: boolean | undefined
  server: string
  projectServer: string
  registeredTools: readonly string[]
}

/** Decide reader access without knowing transports, stores, or credentials. */
export function readerMayCallTool(input: ReaderToolDecision): boolean {
  return (
    input.registeredTools.includes(input.name) ||
    (input.server === input.projectServer && input.readOnlyHint === true)
  )
}

export type ReaderMcpUpstream = {
  listTools(cursor: string | undefined): Promise<{ tools: Tool[]; nextCursor?: string }>
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>
  close(): Promise<void>
}

export type ReaderMcpProxy = {
  server: Server
  close(): Promise<void>
}

async function permittedTools(
  upstream: ReaderMcpUpstream,
  facts: Omit<ReaderToolDecision, 'name' | 'readOnlyHint'>,
): Promise<Tool[]> {
  const tools: Tool[] = []
  let cursor: string | undefined
  do {
    const page = await upstream.listTools(cursor)
    tools.push(
      ...page.tools.filter((tool) =>
        readerMayCallTool({
          ...facts,
          name: tool.name,
          readOnlyHint: tool.annotations?.readOnlyHint,
        }),
      ),
    )
    cursor = page.nextCursor
  } while (cursor)
  return tools
}

function refusedToolCall(name: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: `Reading job may not call tool ${JSON.stringify(name)}.` }],
  }
}

/** Build the filtering server after exhausting the upstream tool catalogue. */
export async function createReaderMcpProxy(
  upstream: ReaderMcpUpstream,
  facts: Omit<ReaderToolDecision, 'name' | 'readOnlyHint'>,
): Promise<ReaderMcpProxy> {
  const tools = await permittedTools(upstream, facts)
  const permitted = new Set(tools.map((tool) => tool.name))
  const server = new Server(
    { name: 'orch-mcp-reader-proxy', version: '0.1.0' },
    { capabilities: { tools: {} } },
  )
  server.setRequestHandler('tools/list', async () => ({ tools }))
  server.setRequestHandler('tools/call', async (request) => {
    const { name, arguments: args } = request.params
    if (!permitted.has(name)) return refusedToolCall(name)
    return upstream.callTool(name, args ?? {})
  })
  return {
    server,
    close: async () => {
      await server.close().catch(() => undefined)
      await upstream.close().catch(() => undefined)
    },
  }
}

function clientUpstream(
  client: Awaited<ReturnType<typeof connectMcpToolClient>>,
): ReaderMcpUpstream {
  const options = () => ({
    signal: AbortSignal.timeout(MCP_PROXY_TIMEOUT_MS),
    timeout: MCP_PROXY_TIMEOUT_MS,
  })
  return {
    listTools: (cursor) => client.client.listTools({ cursor }, options()),
    callTool: (name, args) => client.client.callTool({ name, arguments: args }, options()),
    close: client.close,
  }
}

/** Resolve credentials in-process, connect upstream, then serve only the filtered tool surface. */
async function serveReaderMcpProxy(projectName: string, serverName: string): Promise<void> {
  const project = projectByName(projectName)
  if (!project) throw new Error(`project ${JSON.stringify(projectName)} is not registered`)
  const config = readMcpConfig(project.path)[serverName]
  if (!config) throw new Error('upstream definition is missing')
  const launch: McpToolListLaunch = { ...config, cwd: project.path }
  let connected: Awaited<ReturnType<typeof connectMcpToolClient>>
  try {
    connected = await connectMcpToolClient(launch, process.env as Record<string, string>)
  } catch (error) {
    throw new Error(
      sanitizeProbeError(String((error as Error)?.message ?? error), probeSecrets(config)),
    )
  }
  const registeredTools = project.settings.mcp?.reader_tools?.[serverName] ?? []
  let proxy: ReaderMcpProxy
  try {
    proxy = await createReaderMcpProxy(clientUpstream(connected), {
      server: serverName,
      projectServer: project.settings.mcpServer ?? project.name,
      registeredTools,
    })
  } catch (error) {
    await connected.close().catch(() => undefined)
    throw new Error(
      sanitizeProbeError(String((error as Error)?.message ?? error), probeSecrets(config)),
    )
  }
  try {
    await proxy.server.connect(new StdioServerTransport())
  } catch (error) {
    await proxy.close()
    throw error
  }
}

/** Thin command boundary: one credential-sanitized line and a failing exit status. */
export async function readerMcpProxyCommand(project: string, server: string): Promise<void> {
  try {
    await serveReaderMcpProxy(project, server)
  } catch (error) {
    console.error(
      `MCP reader proxy for ${server} could not start: ${String((error as Error)?.message ?? error).replaceAll(/\s+/g, ' ')}`,
    )
    process.exitCode = 1
  }
}
