// concern: codex-mcp-scope
/**
 * Knows the fixed Codex CLI configuration pins and the MCP servers granted to
 * one run. Must not know dispatch, project lookup, transports, or credentials.
 */
import { dirname, join } from 'node:path'
import { ROOT } from './database-location.ts'

/** Parent environment names Codex may forward into the orch-ask subprocess. */
export const CODEX_ASK_ENV_VARS = ['ORCH_RUN_ID', 'ORCH_RUN_TOKEN', 'ORCH_DB'] as const

/** Worker reasoning is evidence-bearing configuration, never operator config. */
export const CODEX_REASONING_EFFORT = 'medium'

type CodexScopeOpts = {
  mcp?: boolean
  mcpServer?: string
  home?: string
}

type McpServer = {
  command: string
  args: string[]
  env_vars?: readonly string[]
}

function serverOverlay(name: string, server: McpServer): string {
  const fields = [
    `command=${JSON.stringify(server.command)}`,
    `args=${JSON.stringify(server.args)}`,
    ...(server.env_vars ? [`env_vars=${JSON.stringify(server.env_vars)}`] : []),
  ]
  return `mcp_servers.${name}={${fields.join(',')}}`
}

/** Configuration every Codex CLI turn receives before its subcommand. */
export function codexScopeArgs(opts: CodexScopeOpts): string[] {
  const args = [
    '--ignore-user-config',
    '-c', 'features.apps=false',
    '-c', 'features.plugins=false',
    '-c', `model_reasoning_effort=${JSON.stringify(CODEX_REASONING_EFFORT)}`,
  ]
  if (!opts.mcp) return args

  const askServer = {
    command: process.execPath,
    args: [join(dirname(import.meta.path), 'orch.ts'), 'ask-server'],
    env_vars: CODEX_ASK_ENV_VARS,
  }
  const orchServer = { command: join(ROOT, '..', 'bin', 'orch'), args: ['mcp'] }
  args.push('-c', serverOverlay('orch-ask', askServer), '-c', serverOverlay('orch', orchServer))
  if (opts.mcpServer && opts.mcpServer !== 'orch') {
    args.push('-c', serverOverlay(opts.mcpServer, {
      command: join(opts.home ?? '', '.claude', 'mcp', 'mcp-run'),
      args: [opts.mcpServer],
    }))
  }
  return args
}
