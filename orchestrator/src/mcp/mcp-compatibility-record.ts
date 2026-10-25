// concern: mcp-compatibility-record
/** Adapts stored run evidence and project configuration into compatibility rows. */
import type { Database } from 'bun:sqlite'
import { AGENTS } from '../agent/agent-registry.ts'
import { db } from '../database/db.ts'
import { projects } from '../project/projects.ts'
import { decideMcpCompatibility, type McpCompatibilityVerdict } from './mcp-compatibility.ts'
import { bottegaMcpBinary, parseMcpProbe, readMcpConfig, resolveMcpServerLaunch } from './mcp-probe.ts'

export type McpListingObservation = {
  runId: string
  startedAt: string
  connected: number | null
  listedTools: string[]
}

/** Latest catalogue observed for a project server, regardless of which agent probed it. */
export function latestMcpListing(
  projectId: string,
  server: string,
  database: Database = db(),
): McpListingObservation | null {
  const rows = database
    .query(
      `SELECT record_id, started_at, mcp_connected, mcp_probe FROM run
       WHERE project_record_id=? AND mcp_server=? AND mcp_probe IS NOT NULL
       ORDER BY started_at DESC, number DESC`,
    )
    .all(projectId, server) as {
    record_id: string
    started_at: string
    mcp_connected: number | null
    mcp_probe: string
  }[]
  for (const row of rows) {
    const probe = parseMcpProbe(row.mcp_probe)
    if (probe?.listedTools === undefined) continue
    return {
      runId: row.record_id,
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
  lastObservation: { runId: string; time: string; connected: number | null } | null
}

function latestAgentObservation(
  agent: string,
  projectId: string,
  server: string,
  database: Database = db(),
): { runId: string; time: string; connected: number | null } | null {
  const row = database
    .query(
      `SELECT record_id, started_at, mcp_connected FROM run
       WHERE agent=? AND project_record_id=? AND mcp_server=?
       ORDER BY started_at DESC, number DESC LIMIT 1`,
    )
    .get(agent, projectId, server) as {
    record_id: string
    started_at: string
    mcp_connected: number | null
  } | null
  return row ? { runId: row.record_id, time: row.started_at, connected: row.mcp_connected } : null
}

/** Read the derived compatibility record without mutating the store. */
export function mcpCompatibilityRows(projectFilter?: string): McpCompatibilityRow[] {
  const rows: McpCompatibilityRow[] = []
  for (const project of projects().filter(
    (entry) => !projectFilter || entry.name === projectFilter,
  )) {
    const server = project.settings.mcpServer ?? project.name
    const config = resolveMcpServerLaunch(readMcpConfig(project.path), server, bottegaMcpBinary())
    const listing = latestMcpListing(project.recordId, server)
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
        lastObservation: latestAgentObservation(agent, project.recordId, server),
      })
    }
  }
  return rows
}
