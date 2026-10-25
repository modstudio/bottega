// concern: mcp-tool-list
/**
 * Lists every tools/list page through the standard MCP transports. The caller
 * owns scope policy and interpretation of the returned pages.
 */

import type { Stream } from 'node:stream'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { withholdSecretShapedLines } from '../secret-shaped-output.ts'

const MCP_TOOL_LIST_TIMEOUT_MS = 8_000

/** How much of a failed launch's stderr is shown to a probing caller. */
const MCP_STDIO_STDERR_TAIL_BYTES = 4_096

/**
 * Keep the last bytes a child writes to stderr while draining the pipe, so an
 * unread stream can never fill and the caller still learns why a launch failed.
 */
function stdioStderrTail(stream: Stream | null | undefined): () => string {
  if (!stream) return () => ''
  let tail = ''
  stream.on('data', (chunk: Buffer | string) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    tail = `${tail}${text}`.slice(-MCP_STDIO_STDERR_TAIL_BYTES)
  })
  stream.on('error', () => undefined)
  return () => tail.trim()
}

/**
 * Flatten a launch failure into the one line every probe caller reports. The
 * stderr tail is attached in this module, so the shaping lives here too: a
 * caller that flattens again reports the same failure differently.
 */
export function launchFailureReason(error: unknown): string {
  return String((error as Error)?.message ?? error)
    .replaceAll(/\s+/g, ' ')
    .trim()
}

/** The launch failure a caller sees, with the child's own diagnostics appended. */
function launchFailure(error: unknown, tail: string): Error {
  const message = String((error as Error)?.message ?? error)
  const diagnostic = tail ? `${message}\nstderr: ${withholdSecretShapedLines(tail)}` : message
  const failure = new Error(launchFailureReason(diagnostic))
  failure.name = (error as Error)?.name ?? failure.name
  failure.cause = error
  return failure
}

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

export type ConnectedMcpToolClient = {
  client: Client
  close(): Promise<void>
}

/**
 * Connect once so a caller can proxy a complete upstream MCP session.
 *
 * A caller that only probes asks for the stderr tail, because a launch that
 * exits before initialization otherwise reports nothing but a closed
 * connection. Every other caller keeps stderr ignored, so upstream diagnostics
 * never reach an agent and an unread pipe never fills.
 */
export async function connectMcpToolClient(
  launch: McpToolListLaunch,
  env: Record<string, string>,
  options: { stderrTail?: boolean } = {},
): Promise<ConnectedMcpToolClient> {
  const stdio =
    !launch.url && launch.command
      ? new StdioClientTransport({
          command: launch.command,
          args: launch.args ?? [],
          cwd: launch.cwd,
          env: { ...env, ...launch.env },
          stderr: options.stderrTail ? 'pipe' : 'ignore',
        })
      : null
  const readStderrTail = options.stderrTail ? stdioStderrTail(stdio?.stderr) : () => ''
  const transport = launch.url
    ? new StreamableHTTPClientTransport(new URL(launch.url), {
        requestInit: { headers: launch.headers },
      })
    : stdio
  if (!transport) throw new Error('MCP server has no stored launch definition')

  const client = new Client({ name: 'orch-mcp-preflight', version: '0.1.0' })
  const request = {
    signal: AbortSignal.timeout(MCP_TOOL_LIST_TIMEOUT_MS),
    timeout: MCP_TOOL_LIST_TIMEOUT_MS,
  }
  try {
    await client.connect(transport, request)
    return { client, close: () => client.close() }
  } catch (error) {
    await client.close().catch(() => undefined)
    throw launchFailure(error, readStderrTail())
  }
}

async function withMcpClient<T>(
  launch: McpToolListLaunch,
  env: Record<string, string>,
  use: (client: Client, request: { signal: AbortSignal; timeout: number }) => Promise<T>,
  options: { stderrTail?: boolean } = {},
): Promise<T> {
  const connected = await connectMcpToolClient(launch, env, options)
  const request = {
    signal: AbortSignal.timeout(MCP_TOOL_LIST_TIMEOUT_MS),
    timeout: MCP_TOOL_LIST_TIMEOUT_MS,
  }
  try {
    return await use(connected.client, request)
  } finally {
    await connected.close().catch(() => undefined)
  }
}

/** Follow tools/list cursors to exhaustion using one initialized MCP session. */
export async function listMcpToolPages(
  launch: McpToolListLaunch,
  env: Record<string, string>,
): Promise<McpToolPage[]> {
  return withMcpClient(
    launch,
    env,
    async (client, request) => {
      const pages: McpToolPage[] = []
      let cursor: string | undefined
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined, request)
        pages.push({ tools: page.tools.map(({ name }) => ({ name })) })
        cursor = page.nextCursor
      } while (cursor)
      return pages
    },
    // A probe reports why a launch failed, so it keeps the child's own words.
    { stderrTail: true },
  )
}

/** Call one advertised tool through the same standard MCP transports used by preflight. */
export async function callMcpTool(
  launch: McpToolListLaunch,
  env: Record<string, string>,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  return withMcpClient(launch, env, async (client, request) => {
    const result = await client.callTool({ name, arguments: args }, request)
    return unwrapMcpToolResult(result as McpToolResult, name)
  })
}
