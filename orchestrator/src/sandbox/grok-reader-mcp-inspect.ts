// concern: Grok reader MCP inspection
/** Verifies the effective MCP set Grok reports after reader scoping. */

import type { ReaderProxyServer } from './mcp-reader-scope.ts'

type GrokInspectServer = {
  name?: string
  target?: string
  disabled?: boolean
  compatibilityStatus?: string
  source?: { type?: string; path?: string; plugin_name?: string }
}

export type GrokInspectReport = { mcpServers?: GrokInspectServer[] }

function sourceLabel(server: GrokInspectServer): string {
  const source = server.source
  if (!source) return 'unknown source'
  return (
    [source.type, source.path ?? source.plugin_name].filter(Boolean).join(':') || 'unknown source'
  )
}

/** Compare Grok's effective active servers with the platform and run proxy grant. */
export function grokReaderMcpInspectionError(
  report: GrokInspectReport,
  expected: Record<string, ReaderProxyServer>,
  platformServers: readonly string[] = ['orch', 'orch-ask'],
): string | null {
  const active = (report.mcpServers ?? []).filter(
    (server) => server.disabled !== true && server.compatibilityStatus !== 'disabled',
  )
  const allowed = new Set([...platformServers, ...Object.keys(expected)])
  for (const server of active) {
    const name = server.name ?? '<unnamed>'
    if (!allowed.has(name)) {
      return `Grok reader MCP inspection found unexpected server '${name}' from ${sourceLabel(server)}`
    }
    const proxy = expected[name]
    if (proxy && server.target !== proxy.command) {
      return `Grok reader MCP inspection found server '${name}' from ${sourceLabel(server)} using ${JSON.stringify(server.target ?? '<missing>')} instead of the reader proxy`
    }
  }
  const activeNames = new Set(active.map((server) => server.name).filter(Boolean))
  const missing = Object.keys(expected).find((name) => !activeNames.has(name))
  return missing
    ? `Grok reader MCP inspection did not find expected proxy server '${missing}'`
    : null
}

/** Ask the installed Grok CLI for the merged configuration it would launch. */
export function inspectGrokReaderMcp(
  bin: string,
  cwd: string,
  environment: Record<string, string>,
  expected: Record<string, ReaderProxyServer>,
): string | null {
  const inspected = Bun.spawnSync([bin, 'inspect', '--json'], {
    cwd,
    env: environment,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdout = inspected.stdout.toString().trim()
  const stderr = inspected.stderr.toString().trim()
  if (inspected.exitCode !== 0) {
    return `Grok reader MCP inspection failed: ${stderr || stdout || `exit ${inspected.exitCode}`}`
  }
  try {
    return grokReaderMcpInspectionError(JSON.parse(stdout) as GrokInspectReport, expected)
  } catch (error) {
    return `Grok reader MCP inspection returned invalid JSON: ${String((error as Error).message ?? error)}`
  }
}
