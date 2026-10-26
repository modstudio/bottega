// concern: mcp-reader-proxy
/** Filters one project MCP server down to tools a reading job may call. */

import { realpathSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import type { CallToolResult, Tool } from '@modelcontextprotocol/client'
import { Server } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { STATE_HOME_ENV } from '../../../shared/state-directory.ts'
import {
  type Project,
  projectByName,
  retiredProjectByName,
  retiredProjectRefusal,
} from '../project/projects.ts'
import {
  bottegaMcpBinary,
  type McpConfigReadResult,
  type McpServerLaunchResolution,
  probeSecrets,
  readMcpConfigResult,
  resolveMcpServerLaunchFromRead,
  sanitizeProbeError,
} from './mcp-probe.ts'
import { type ReaderToolDecision, readerMayCallTool } from './mcp-reader-policy.ts'
import { connectMcpToolClient, type McpToolListLaunch } from './mcp-tool-list.ts'

const MCP_PROXY_LIST_TIMEOUT_MS = 8_000
const MCP_PROXY_CALL_TIMEOUT_MS = 2 * 60_000

export const MCP_UPSTREAM_INHERITED_ENV = [
  'PATH',
  'HOME',
  'LANG',
  'TMPDIR',
  'USER',
  'SHELL',
] as const

/**
 * Names the platform's own server needs to reach the operator's store. A worker
 * HOME is run-scoped, so without these the built-in upstream would serve a
 * fresh empty store instead of the operator's.
 */
export const MCP_UPSTREAM_STORE_ENV = [
  'BOTTEGA_ORCHESTRATOR_DB',
  'BOTTEGA_HUB_DB',
  STATE_HOME_ENV,
  'XDG_STATE_HOME',
] as const

/**
 * Give an upstream only its declared environment and the variables its launch
 * needs. A `.mcp.json` entry carries its own credentials, so it keeps the
 * narrow allowlist; the platform's built-in server also inherits the store
 * names, which is how it finds the operator's store rather than a fresh one.
 */
export function readerMcpUpstreamEnvironment(
  environment: Record<string, string | undefined>,
  declared: Record<string, string> | undefined,
  builtInPlatformServer = false,
): Record<string, string> {
  const names: readonly string[] = builtInPlatformServer
    ? [...MCP_UPSTREAM_INHERITED_ENV, ...MCP_UPSTREAM_STORE_ENV]
    : MCP_UPSTREAM_INHERITED_ENV
  const inherited = Object.fromEntries(
    names.flatMap((name) => (environment[name] === undefined ? [] : [[name, environment[name]!]])),
  )
  return { ...inherited, ...declared }
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
  const options = (timeout: number) => ({
    signal: AbortSignal.timeout(timeout),
    timeout,
  })
  return {
    listTools: (cursor) => client.client.listTools({ cursor }, options(MCP_PROXY_LIST_TIMEOUT_MS)),
    callTool: (name, args) =>
      client.client.callTool({ name, arguments: args }, options(MCP_PROXY_CALL_TIMEOUT_MS)),
    close: client.close,
  }
}

type ReaderProxyProject = Pick<Project, 'name' | 'path' | 'settings'>

type ReaderMcpProxyDependencies = {
  projectByName(name: string): ReaderProxyProject | null
  retiredProjectByName(name: string): ReaderProxyProject | null
  readMcpConfigResult(cwd: string): McpConfigReadResult
  connectMcpToolClient: typeof connectMcpToolClient
  environment: Record<string, string | undefined>
}

const readerMcpProxyDependencies: ReaderMcpProxyDependencies = {
  projectByName,
  retiredProjectByName,
  readMcpConfigResult,
  connectMcpToolClient,
  environment: process.env,
}

function runTreePath(runTree: string, mainCheckout: string): string {
  const tree = resolve(runTree)
  const main = resolve(mainCheckout)
  if (tree === main)
    throw new Error(`run tree ${JSON.stringify(tree)} is the registered main checkout`)
  try {
    if (!statSync(tree).isDirectory()) throw new Error('not a directory')
  } catch {
    throw new Error(`run tree ${JSON.stringify(tree)} is not an existing directory`)
  }
  try {
    if (realpathSync(tree) === realpathSync(main)) {
      throw new Error(`run tree ${JSON.stringify(tree)} is the registered main checkout`)
    }
  } catch (error) {
    if (String((error as Error)?.message ?? error).includes('registered main checkout')) throw error
  }
  return tree
}

/** How a launch file that could not be read is refused, naming the file and why. */
function unreadableLaunchFileRefusal(result: Extract<McpConfigReadResult, { ok: false }>): string {
  if (result.reason === 'missing') return `MCP configuration is missing at ${result.path}`
  if (result.reason === 'invalid') return `MCP configuration is not valid JSON at ${result.path}`
  return `MCP configuration could not be read at ${result.path}${result.detail ? `: ${result.detail}` : ''}`
}

/**
 * Resolve the upstream through the one resolution the reader selection uses.
 * An absent launch file is no evidence about any name and Bottega's own server
 * is registered at user scope rather than in the tree, so that name still
 * starts the built-in launch; every other name keeps the missing-file refusal.
 * A file that could not be read is reported for every name, the platform's
 * included, instead of being read as an absent one.
 */
function resolvedUpstream(
  result: McpConfigReadResult,
  serverName: string,
): McpServerLaunchResolution {
  const resolved = resolveMcpServerLaunchFromRead(result, serverName, bottegaMcpBinary())
  if (resolved) return resolved
  if (!result.ok) throw new Error(unreadableLaunchFileRefusal(result))
  throw new Error(
    `server ${JSON.stringify(serverName)} is not configured in ${result.path}; add its launch definition there`,
  )
}

/** Resolve credentials in-process, connect upstream, then serve only the filtered tool surface. */
async function serveReaderMcpProxy(
  projectName: string,
  serverName: string,
  runTree: string,
  dependencies: ReaderMcpProxyDependencies,
): Promise<void> {
  const project = dependencies.projectByName(projectName)
  if (!project) {
    if (dependencies.retiredProjectByName(projectName))
      throw new Error(retiredProjectRefusal(projectName))
    throw new Error(
      `project ${JSON.stringify(projectName)} is not registered; run ${PLATFORM_SLUG} project add <path> --name ${JSON.stringify(projectName)}`,
    )
  }
  const cwd = runTreePath(runTree, project.path)
  const { config, builtIn } = resolvedUpstream(
    dependencies.readMcpConfigResult(project.path),
    serverName,
  )
  const launch: McpToolListLaunch = { ...config, cwd }
  let connected: Awaited<ReturnType<typeof connectMcpToolClient>>
  try {
    connected = await dependencies.connectMcpToolClient(
      launch,
      readerMcpUpstreamEnvironment(dependencies.environment, config.env, builtIn),
    )
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
  serveStdio(() => proxy.server)
}

type ReaderMcpProxyCommandDependencies = Partial<ReaderMcpProxyDependencies> & {
  error?(line: string): void
  setExitCode?(code: number): void
}

/** Thin command boundary: one credential-sanitized line and a failing exit status. */
export async function readerMcpProxyCommand(
  project: string,
  server: string,
  runTree: string,
  overrides: ReaderMcpProxyCommandDependencies = {},
): Promise<void> {
  const dependencies = { ...readerMcpProxyDependencies, ...overrides }
  const writeError = overrides.error ?? ((line: string) => console.error(line))
  const setExitCode = overrides.setExitCode ?? ((code: number) => (process.exitCode = code))
  try {
    await serveReaderMcpProxy(project, server, runTree, dependencies)
  } catch (error) {
    writeError(
      `MCP reader proxy for ${server} could not start: ${String((error as Error)?.message ?? error).replaceAll(/\s+/g, ' ')}`,
    )
    setExitCode(1)
  }
}
