// concern: codex-mcp-scope
/**
 * Knows the fixed Codex CLI configuration pins and the MCP servers granted to
 * one run. Must not know dispatch, project lookup, transports, or credentials.
 */
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { ROOT } from '../database/database-location.ts'
import { disabledProjectMcpServers, type McpServerConfig, readMcpConfig } from '../mcp/mcp-probe.ts'
import type { McpToolPage } from '../mcp/mcp-tool-list.ts'

/** Parent environment names Codex may forward into the orch-ask subprocess. */
export const CODEX_ASK_ENV_VARS = ['ORCH_RUN_ID', 'ORCH_RUN_TOKEN', 'ORCH_DB'] as const

/** Worker reasoning is evidence-bearing configuration, never operator config. */
export const CODEX_REASONING_EFFORT = 'medium'

type CodexScopeOpts = {
  mcp?: boolean
  mcpServer?: string
  projectServers?: Record<string, CodexMcpServer>
  home?: string
}

export type CodexMcpServer = {
  command?: string
  args?: string[]
  cwd?: string
  url?: string
  env_vars?: readonly string[]
}

export type CodexMcpScope = { servers: Record<string, CodexMcpServer>; withheld: string[] }

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

/** Select project MCP launch definitions that are safe to expose on argv. */
export function codexProjectServers(
  config: Record<string, McpServerConfig>,
  allowed: string[] | undefined,
  cwd: string,
): CodexMcpScope {
  const disabled = new Set(disabledProjectMcpServers(Object.keys(config), allowed))
  const servers: Record<string, CodexMcpServer> = {}
  const withheld: string[] = []
  for (const [name, entry] of Object.entries(config)) {
    if (disabled.has(name)) continue
    if (Object.keys(entry.env ?? {}).length || Object.keys(entry.headers ?? {}).length) {
      withheld.push(name)
    } else if (entry.url) {
      servers[name] = { url: entry.url }
    } else if (entry.command) {
      const command =
        entry.command.includes('/') && !isAbsolute(entry.command)
          ? resolve(cwd, entry.command)
          : entry.command
      servers[name] = { command, args: entry.args ?? [], cwd }
    } else {
      withheld.push(name)
    }
  }
  return { servers, withheld }
}

/**
 * Select project servers only for MCP-enabled Codex CLI runs. `.mcp.json` is
 * usually gitignored, so a worker tree cut from git lacks it; the project's
 * registered checkout then supplies the definitions.
 */
export function codexProjectServersForRun(
  agent: string,
  transport: string,
  mcp: boolean,
  treeConfig: Record<string, McpServerConfig>,
  project: { path: string; settings: { workerMcpServers?: string[] } } | null,
  cwd: string,
): ReturnType<typeof codexProjectServers> | null {
  if (agent !== 'codex' || transport !== 'cli' || !mcp) return null
  const config =
    Object.keys(treeConfig).length || !project ? treeConfig : readMcpConfig(project.path)
  return codexProjectServers(config, project?.settings.workerMcpServers, cwd)
}

/** Append the visible reason when project MCP definitions cannot enter argv. */
export function codexMcpSetupHeader(
  header: string | null,
  scope: ReturnType<typeof codexProjectServers> | null,
  catalogues: CodexMcpCatalogue[] = [],
): string | null {
  const lines = scope?.withheld.length
    ? [
        `MCP scope: codex withheld ${scope.withheld.join(', ')} (inline env/headers or no launch definition)`,
      ]
    : []
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
  if (!lines.length) return header
  return [header, ...lines].filter(Boolean).join('\n')
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
  if (!opts.mcp) return args

  const askServer = {
    command: process.execPath,
    args: ['--no-env-file', join(dirname(import.meta.path), '..', 'cli', 'orch.ts'), 'ask-server'],
    env_vars: CODEX_ASK_ENV_VARS,
  }
  const orchServer = { command: join(ROOT, '..', 'bin', 'orch'), args: ['mcp'] }
  args.push('-c', serverOverlay('orch-ask', askServer), '-c', serverOverlay('orch', orchServer))
  for (const [name, server] of Object.entries(opts.projectServers ?? {})) {
    if (name !== 'orch-ask' && name !== 'orch') args.push('-c', serverOverlay(name, server))
  }
  if (opts.mcpServer && opts.mcpServer !== 'orch' && !opts.projectServers?.[opts.mcpServer]) {
    args.push(
      '-c',
      serverOverlay(opts.mcpServer, {
        command: join(opts.home ?? '', '.claude', 'mcp', 'mcp-run'),
        args: [opts.mcpServer],
      }),
    )
  }
  return args
}
