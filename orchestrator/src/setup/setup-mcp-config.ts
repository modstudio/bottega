// concern: setup MCP configuration migration contract
/** Owns legacy MCP identities and the pure JSON rewrite shared by setup planning and apply. */

import { MCP_SERVER_NAME, MCP_TOOL_PREFIX, WORKER_MCP_SERVER_NAME } from '../../../shared/brand.ts'

export const LEGACY_MCP_SERVER_NAMES = {
  [MCP_SERVER_NAME]: 'orch',
  [WORKER_MCP_SERVER_NAME]: 'orch-ask',
} as const
export type LegacyMcpServerName =
  (typeof LEGACY_MCP_SERVER_NAMES)[keyof typeof LEGACY_MCP_SERVER_NAMES]
export const LEGACY_MCP_TOOL_PREFIX = 'mcp__orch__'

type McpConfigMigrationSummary = {
  serverKeysRenamed: { from: LegacyMcpServerName; to: keyof typeof LEGACY_MCP_SERVER_NAMES }[]
  toolPrefixKeysRewritten: number
  toolPrefixValuesRewritten: number
}
export type McpConfigMigration = { path: string; summary: McpConfigMigrationSummary }

function rewrite(
  value: unknown,
  summary: McpConfigMigrationSummary,
  renameServerKeys: boolean,
): unknown {
  if (typeof value === 'string') {
    const rewritten = value.replaceAll(LEGACY_MCP_TOOL_PREFIX, MCP_TOOL_PREFIX)
    if (rewritten !== value) summary.toolPrefixValuesRewritten++
    return rewritten
  }
  if (Array.isArray(value)) return value.map((child) => rewrite(child, summary, renameServerKeys))
  if (!value || typeof value !== 'object') return value
  const source = value as Record<string, unknown>
  const rewritten = Object.fromEntries(
    Object.entries(source).map(([key, child]) => {
      const rewrittenKey = key.replaceAll(LEGACY_MCP_TOOL_PREFIX, MCP_TOOL_PREFIX)
      if (rewrittenKey !== key) summary.toolPrefixKeysRewritten++
      return [rewrittenKey, rewrite(child, summary, renameServerKeys)]
    }),
  )
  const servers = rewritten.mcpServers
  if (renameServerKeys && servers && typeof servers === 'object' && !Array.isArray(servers)) {
    const table = servers as Record<string, unknown>
    for (const [to, from] of Object.entries(LEGACY_MCP_SERVER_NAMES) as [
      keyof typeof LEGACY_MCP_SERVER_NAMES,
      LegacyMcpServerName,
    ][]) {
      if (!Object.hasOwn(table, from)) continue
      table[to] ??= table[from]
      delete table[from]
      summary.serverKeysRenamed.push({ from, to })
    }
  }
  return rewritten
}

export function migrateMcpConfig(
  text: string,
  options: { renameServerKeys?: boolean } = {},
): {
  text: string
  summary: McpConfigMigrationSummary
} {
  const parsed = JSON.parse(text)
  const summary: McpConfigMigrationSummary = {
    serverKeysRenamed: [],
    toolPrefixKeysRewritten: 0,
    toolPrefixValuesRewritten: 0,
  }
  const rewritten = rewrite(parsed, summary, options.renameServerKeys ?? true)
  const after = `${JSON.stringify(rewritten, null, 2)}\n`
  return {
    text: JSON.stringify(parsed) === JSON.stringify(rewritten) ? text : after,
    summary,
  }
}

/** Preserve an unchanged file byte-for-byte; serialize only an actual migration. */
export function migrateMcpConfigText(
  text: string,
  options: { renameServerKeys?: boolean } = {},
): string {
  return migrateMcpConfig(text, options).text
}
