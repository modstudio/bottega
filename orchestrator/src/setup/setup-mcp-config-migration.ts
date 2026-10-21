// concern: setup MCP configuration migration
/** Finds and rewrites legacy MCP identities in setup-owned JSON configuration. */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MCP_SERVER_NAME, MCP_TOOL_PREFIX, WORKER_MCP_SERVER_NAME } from '../../../shared/brand.ts'

const LEGACY_TOOL_PREFIX = ['mcp', '', 'orch', '', ''].join('_')

export type McpConfigMigration = { path: string; before: string; after: string }

function rewrite(value: unknown): unknown {
  if (typeof value === 'string') return value.replaceAll(LEGACY_TOOL_PREFIX, MCP_TOOL_PREFIX)
  if (Array.isArray(value)) return value.map(rewrite)
  if (!value || typeof value !== 'object') return value
  const source = value as Record<string, unknown>
  const rewritten = Object.fromEntries(
    Object.entries(source).map(([key, child]) => [
      key.replaceAll(LEGACY_TOOL_PREFIX, MCP_TOOL_PREFIX),
      rewrite(child),
    ]),
  )
  const servers = rewritten.mcpServers
  if (servers && typeof servers === 'object' && !Array.isArray(servers)) {
    const table = servers as Record<string, unknown>
    if (Object.hasOwn(table, 'orch')) {
      table[MCP_SERVER_NAME] ??= table.orch
      delete table.orch
    }
    if (Object.hasOwn(table, 'orch-ask')) {
      table[WORKER_MCP_SERVER_NAME] ??= table['orch-ask']
      delete table['orch-ask']
    }
  }
  return rewritten
}

/** Preserve an unchanged file byte-for-byte; serialize only an actual migration. */
export function migrateMcpConfigText(text: string): string {
  const after = `${JSON.stringify(rewrite(JSON.parse(text)), null, 2)}\n`
  return JSON.stringify(JSON.parse(text)) === JSON.stringify(JSON.parse(after)) ? text : after
}

export function captureMcpConfigMigrations(
  home: string,
  projectPaths: readonly string[],
): McpConfigMigration[] {
  const candidates = [
    join(home, '.claude.json'),
    ...projectPaths.flatMap((path) => [
      join(path, '.mcp.json'),
      join(path, '.claude', 'settings.json'),
      join(path, '.claude', 'settings.local.json'),
    ]),
  ]
  return candidates.flatMap((path) => {
    if (!existsSync(path)) return []
    const before = readFileSync(path, 'utf8')
    const after = migrateMcpConfigText(before)
    return after === before ? [] : [{ path, before, after }]
  })
}
