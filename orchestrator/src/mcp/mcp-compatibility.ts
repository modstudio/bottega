// concern: mcp-compatibility
/** Derives harness/server compatibility from existing run evidence. */
import type { Database } from 'bun:sqlite'
import { AGENTS } from '../agent/agent-registry.ts'
import { db } from '../database/db.ts'
import { projects } from '../project/projects.ts'
import { parseMcpProbe, readMcpConfig } from './mcp-probe.ts'

export type McpCompatibilityVerdict = 'compatible' | 'partial' | 'incompatible' | 'unknown'

export type RequiredMcpServer = { projectId: number; project: string; server: string }

export type McpCompatibility = {
  listed: string[] | null
  admitted: string[] | null
  verdict: McpCompatibilityVerdict
}

/** Decide which listed tool names a harness can admit. */
export function decideMcpCompatibility(
  listedTools: string[] | undefined,
  pattern?: string,
): McpCompatibility {
  if (listedTools === undefined) return { listed: null, admitted: null, verdict: 'unknown' }
  const listed = [...listedTools]
  const admitted = pattern ? listed.filter((name) => new RegExp(pattern).test(name)) : [...listed]
  const verdict =
    admitted.length === listed.length
      ? 'compatible'
      : admitted.length === 0
        ? 'incompatible'
        : 'partial'
  return { listed, admitted, verdict }
}

export type McpListingObservation = {
  runId: number
  startedAt: string
  connected: number | null
  listedTools: string[]
}

/** Latest catalogue observed for a project server, regardless of which agent probed it. */
export function latestMcpListing(
  projectId: number,
  server: string,
  database: Database = db(),
): McpListingObservation | null {
  const rows = database
    .query(
      `SELECT id, started_at, mcp_connected, mcp_probe FROM run
       WHERE project_id=? AND mcp_server=? AND mcp_probe IS NOT NULL
       ORDER BY started_at DESC, id DESC`,
    )
    .all(projectId, server) as {
    id: number
    started_at: string
    mcp_connected: number | null
    mcp_probe: string
  }[]
  for (const row of rows) {
    const probe = parseMcpProbe(row.mcp_probe)
    if (probe?.listedTools === undefined) continue
    return {
      runId: row.id,
      startedAt: row.started_at,
      connected: row.mcp_connected,
      listedTools: probe.listedTools,
    }
  }
  return null
}

export type McpCompatibilityRow = {
  harness: string
  agent: string
  project: string
  server: string
  listed: number | null
  admitted: number | null
  verdict: McpCompatibilityVerdict
  pattern: string | null
  transport: 'url' | 'command' | 'unknown'
  auth: 'bearer' | 'header' | 'none'
  lastObservation: { runId: number; time: string; connected: number | null } | null
}

function latestAgentObservation(
  agent: string,
  projectId: number,
  server: string,
): { runId: number; time: string; connected: number | null } | null {
  const row = db()
    .query(
      `SELECT id, started_at, mcp_connected FROM run
       WHERE agent=? AND project_id=? AND mcp_server=?
       ORDER BY started_at DESC, id DESC LIMIT 1`,
    )
    .get(agent, projectId, server) as {
    id: number
    started_at: string
    mcp_connected: number | null
  } | null
  return row ? { runId: row.id, time: row.started_at, connected: row.mcp_connected } : null
}

/** Read the derived compatibility record without mutating the store. */
export function mcpCompatibilityRows(projectFilter?: string): McpCompatibilityRow[] {
  const rows: McpCompatibilityRow[] = []
  for (const project of projects().filter(
    (entry) => !projectFilter || entry.name === projectFilter,
  )) {
    const server = project.settings.mcpServer ?? project.name
    const config = readMcpConfig(project.path)[server]
    const listing = latestMcpListing(project.id, server)
    const headers = config?.headers ?? {}
    const auth = Object.entries(headers).some(
      ([name, value]) => name.toLowerCase() === 'authorization' && /^bearer\s+/i.test(value),
    )
      ? 'bearer'
      : Object.keys(headers).length
        ? 'header'
        : 'none'
    for (const [agent, declaration] of Object.entries(AGENTS)) {
      const compatibility = decideMcpCompatibility(
        listing?.listedTools,
        declaration.mcpToolNamePattern,
      )
      rows.push({
        harness: declaration.harness ?? declaration.name,
        agent,
        project: project.name,
        server,
        listed: compatibility.listed?.length ?? null,
        admitted: compatibility.admitted?.length ?? null,
        verdict: compatibility.verdict,
        pattern: declaration.mcpToolNamePattern ?? null,
        transport: config?.url ? 'url' : config?.command ? 'command' : 'unknown',
        auth,
        lastObservation: latestAgentObservation(agent, project.id, server),
      })
    }
  }
  return rows
}

export function mcpIncompatibilityReason(input: {
  server: string
  pattern: string
  compatibility: McpCompatibility
}): string {
  return (
    `MCP server '${input.server}' tool-name grammar is incompatible: ` +
    `${input.compatibility.admitted?.length ?? 0}/${input.compatibility.listed?.length ?? 0} admitted ` +
    `by ${input.pattern}`
  )
}

/** Refuse a just-observed catalogue the selected harness cannot admit. */
export function mcpGrammarMismatchRefusal(input: {
  server: string
  listedTools: string[] | undefined
  pattern?: string
}): string | null {
  if (!input.pattern) return null
  const compatibility = decideMcpCompatibility(input.listedTools, input.pattern)
  if (compatibility.verdict !== 'incompatible') return null
  return `${mcpIncompatibilityReason({
    server: input.server,
    pattern: input.pattern,
    compatibility,
  })}; re-dispatch to route to a compatible agent`
}
