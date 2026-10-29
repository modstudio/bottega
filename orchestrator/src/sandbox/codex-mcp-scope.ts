// concern: codex-mcp-scope
/**
 * Knows the fixed Codex CLI configuration pins and the MCP servers granted to
 * one run. Must not know dispatch, project lookup, transports, or credentials.
 */
import { join } from 'node:path'
/** Parent environment names Codex may forward into the bottega-ask subprocess. */
import { MCP_SERVER_NAME, PLATFORM_SLUG, WORKER_MCP_SERVER_NAME } from '../../../shared/brand.ts'
import { bottegaEntryArgv } from '../../../shared/self-spawn.ts'
import type { McpToolPage } from '../mcp/mcp-tool-list.ts'
import {
  mergeMcpSetupHeader,
  type ProjectMcpSelection,
  type ProjectMcpServer,
  type ProjectMcpWithheld,
  projectMcpWithheldLine,
} from './project-mcp-scope.ts'
export const CODEX_ASK_ENV_VARS = [
  'BOTTEGA_RUN_ID',
  'BOTTEGA_RUN_TOKEN',
  'BOTTEGA_ORCHESTRATOR_DB',
] as const
/** Parent environment names Codex may forward into the read-mostly orchestrator subprocess. */
export const CODEX_ORCH_ENV_VARS = ['BOTTEGA_RUN_ID', 'BOTTEGA_DEPTH'] as const

/** Worker reasoning is evidence-bearing configuration, never operator config. */
export const CODEX_REASONING_EFFORT = 'medium'

type CodexScopeOpts = {
  mcp?: boolean
  mcpServer?: string
  projectServers?: Record<string, CodexMcpServer>
  withheldProjectServers?: string[]
  home?: string
}

type CodexMcpServer = {
  command?: string
  args?: string[]
  cwd?: string
  url?: string
  env_vars?: readonly string[]
}

export type CodexMcpScope = {
  servers: Record<string, CodexMcpServer>
  withheld: ProjectMcpWithheld[]
}

export type CodexMcpCatalogue =
  | { server: string; pages: McpToolPage[]; error?: never }
  | { server: string; error: string; pages?: never }

/** Decide which tool names Codex misses when it reads only page one. */
export function codexWithheldTools(pages: McpToolPage[]): {
  seen: number
  total: number
  withheld: string[]
} {
  return {
    seen: pages[0]?.tools.length ?? 0,
    total: pages.reduce((count, page) => count + page.tools.length, 0),
    withheld: pages.slice(1).flatMap((page) => page.tools.map((tool) => tool.name)),
  }
}

function serverOverlay(name: string, server: CodexMcpServer): string {
  const fields = [
    ...(server.command ? [`command=${JSON.stringify(server.command)}`] : []),
    ...(server.args ? [`args=${JSON.stringify(server.args)}`] : []),
    ...(server.cwd ? [`cwd=${JSON.stringify(server.cwd)}`] : []),
    ...(server.url ? [`url=${JSON.stringify(server.url)}`] : []),
    ...(server.env_vars ? [`env_vars=${JSON.stringify(server.env_vars)}`] : []),
  ]
  return `mcp_servers.${name}={${fields.join(',')}}`
}

export function codexAskServerCommand(): string[] {
  return bottegaEntryArgv('ask-server')
}

function codexServers(servers: Record<string, ProjectMcpServer>): Record<string, CodexMcpServer> {
  const rendered: Record<string, CodexMcpServer> = {}
  for (const [name, server] of Object.entries(servers)) {
    rendered[name] =
      'url' in server
        ? { url: server.url }
        : { command: server.command, args: server.args, cwd: server.cwd }
  }
  return rendered
}

/**
 * Render the launch's already-decided project selection as Codex argv entries.
 * A Codex CLI run reports its own scope in its setup header, so it never
 * renders anything a non-Codex harness or an ACP session renders instead.
 */
export function codexProjectServersFromSelection(
  selection: ProjectMcpSelection | null,
  agent: string,
  transport: string,
): CodexMcpScope | null {
  if (agent !== 'codex' || transport !== 'cli' || !selection) return null
  if (selection.kind === 'reader')
    return { servers: selection.servers, withheld: selection.withheld }
  return { servers: codexServers(selection.servers), withheld: selection.withheld }
}

/** Append the visible reason when project MCP definitions cannot enter argv. */
export function codexMcpSetupHeader(
  header: string | null,
  scope: CodexMcpScope | null,
  catalogues: CodexMcpCatalogue[] = [],
): string | null {
  const withheldLine = projectMcpWithheldLine('codex', scope?.withheld ?? [])
  const lines = withheldLine ? [withheldLine] : []
  for (const catalogue of catalogues) {
    if (catalogue.error !== undefined) {
      lines.push(
        `MCP scope: ${catalogue.server} tools/list failed (${catalogue.error}); codex catalogue unknown`,
      )
      continue
    }
    if (catalogue.pages.length <= 1) continue
    const result = codexWithheldTools(catalogue.pages)
    lines.push(
      `MCP scope: codex sees only the first ${result.seen} of ${result.total} ${catalogue.server} tools; withheld: ${result.withheld.join(', ')}`,
    )
  }
  return lines.reduce<string | null>((merged, line) => mergeMcpSetupHeader(merged, line), header)
}

/** Configuration every Codex CLI turn receives before its subcommand. */
export function codexScopeArgs(opts: CodexScopeOpts): string[] {
  const args = [
    '--ignore-user-config',
    '-c',
    'features.apps=false',
    '-c',
    'features.plugins=false',
    '-c',
    `model_reasoning_effort=${JSON.stringify(CODEX_REASONING_EFFORT)}`,
  ]
  const [askCommand, ...askArgs] = codexAskServerCommand()
  const askServer = {
    command: askCommand,
    args: askArgs,
    env_vars: CODEX_ASK_ENV_VARS,
  }
  args.push('-c', serverOverlay(WORKER_MCP_SERVER_NAME, askServer))
  if (!opts.mcp) return args

  const [orchCommand, ...orchArgs] = bottegaEntryArgv(PLATFORM_SLUG)
  const orchServer = {
    command: orchCommand,
    args: [...orchArgs, 'mcp', 'serve'],
    env_vars: CODEX_ORCH_ENV_VARS,
  }
  args.push('-c', serverOverlay(MCP_SERVER_NAME, orchServer))
  for (const [name, server] of Object.entries(opts.projectServers ?? {})) {
    if (name !== WORKER_MCP_SERVER_NAME && name !== MCP_SERVER_NAME) {
      args.push('-c', serverOverlay(name, server))
    }
  }
  if (
    opts.mcpServer &&
    opts.mcpServer !== MCP_SERVER_NAME &&
    !opts.projectServers?.[opts.mcpServer] &&
    !opts.withheldProjectServers?.includes(opts.mcpServer)
  ) {
    const fallback = {
      command: join(opts.home ?? '', '.claude', 'mcp', 'mcp-run'),
      args: [opts.mcpServer],
    }
    args.push('-c', serverOverlay(opts.mcpServer, fallback))
  }
  return args
}
