// concern: Grok reader MCP inspection
/** Verifies the effective MCP set Grok reports after reader scoping. */

import { realpathSync } from 'node:fs'
import type { ReaderProxyServer } from './mcp-reader-scope.ts'

type GrokInspectServer = {
  name?: string
  target?: string
  disabled?: boolean
  compatibilityStatus?: string
  source?: { type?: string; path?: string; plugin_name?: string }
}

type GrokInspectConfigLayer = { role?: string; path?: string }

export type GrokInspectReport = {
  mcpServers?: GrokInspectServer[]
  configSources?: { layers?: GrokInspectConfigLayer[] }
}

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
  runConfigPath: string,
  platformServers: readonly string[],
): string | null {
  const layers = report.configSources?.layers
  if (!layers) return 'Grok reader MCP inspection did not report config source layers'
  if (layers.length === 0) return 'Grok reader MCP inspection reported no config source layers'
  const unexpectedLayer = layers.find(
    (layer, index) => index !== 0 || layer.path !== runConfigPath,
  )
  if (unexpectedLayer) {
    return `Grok reader MCP inspection found config layer '${unexpectedLayer.role ?? '<unknown>'}' at ${JSON.stringify(unexpectedLayer.path ?? '<missing>')} instead of only the run home`
  }

  const active = (report.mcpServers ?? []).filter(
    (server) => server.disabled !== true && server.compatibilityStatus !== 'disabled',
  )
  const allowed = new Set([...platformServers, ...Object.keys(expected)])
  for (const server of active) {
    const name = server.name ?? '<unnamed>'
    if (!allowed.has(name)) {
      return `Grok reader MCP inspection found unexpected server '${name}' from ${sourceLabel(server)}`
    }
    if (server.source?.path !== runConfigPath) {
      return `Grok reader MCP inspection found server '${name}' from ${sourceLabel(server)} instead of the run home`
    }
    const proxy = expected[name]
    if (proxy && server.target !== proxy.command) {
      return `Grok reader MCP inspection found server '${name}' from ${sourceLabel(server)} using ${JSON.stringify(server.target ?? '<missing>')} instead of the reader proxy`
    }
  }
  const activeNames = new Set(active.map((server) => server.name).filter(Boolean))
  const missing = [...platformServers, ...Object.keys(expected)].find(
    (name) => !activeNames.has(name),
  )
  return missing ? `Grok reader MCP inspection did not find expected server '${missing}'` : null
}

function canonicalInspectReport(report: GrokInspectReport): GrokInspectReport {
  return {
    ...report,
    configSources: report.configSources
      ? {
          ...report.configSources,
          layers: report.configSources.layers?.map((layer) => ({
            ...layer,
            path: layer.path ? canonicalPath(layer.path) : layer.path,
          })),
        }
      : undefined,
    mcpServers: report.mcpServers?.map((server) => ({
      ...server,
      source: server.source?.path
        ? { ...server.source, path: canonicalPath(server.source.path) }
        : server.source,
    })),
  }
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** Ask the installed Grok CLI for the merged configuration it would launch. */
export function inspectGrokReaderMcp(
  bin: string,
  cwd: string,
  environment: Record<string, string>,
  expected: Record<string, ReaderProxyServer>,
  runConfigPath: string,
  platformServers: readonly string[],
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
    return grokReaderMcpInspectionError(
      canonicalInspectReport(JSON.parse(stdout) as GrokInspectReport),
      expected,
      realpathSync(runConfigPath),
      platformServers,
    )
  } catch (error) {
    return `Grok reader MCP inspection returned invalid JSON: ${String((error as Error).message ?? error)}`
  }
}
