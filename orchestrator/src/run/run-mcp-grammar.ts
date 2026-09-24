// concern: run-mcp-grammar
/** Owns the run's derived MCP evidence reads, writes, and pre-launch grammar refusal. */

import { db } from '../database/db.ts'
import type { StreamEvent } from '../events.ts'
import { mcpGrammarMismatchRefusal } from '../mcp/mcp-compatibility.ts'
import type { McpMode } from '../mcp/mcp-preflight.ts'
import type { McpProbeResult } from '../mcp/mcp-probe.ts'
import { teardownTerminalRunResources } from '../resources/resource-ownership.ts'
import { decideFinalMcpConnection } from './run-mcp-attachment.ts'

export function finalWorkerMcpRuling(
  runId: number,
  mcpMode: McpMode | null,
  requiredServer: string | null,
  workerEvents: readonly StreamEvent[],
): ReturnType<typeof decideFinalMcpConnection> | null {
  if (!mcpMode || !requiredServer) return null
  const recorded = db().query('SELECT mcp_connected, mcp_error FROM run WHERE id=?').get(runId) as {
    mcp_connected: number | null
    mcp_error: string | null
  } | null
  return decideFinalMcpConnection({
    requiredServer,
    mcpMode,
    preLaunchEvidence: recorded
      ? {
          server: requiredServer,
          connected: recorded.mcp_connected === null ? null : recorded.mcp_connected === 1,
          error: recorded.mcp_error,
        }
      : null,
    workerEvents,
  })
}

export async function enforceRunMcpGrammar(input: {
  server: string
  pattern?: string
  probe: McpProbeResult
  runId: number
  started: number
  resetSandbox(): Promise<void>
}): Promise<void> {
  const why = mcpGrammarMismatchRefusal({
    server: input.server,
    listedTools: input.probe.listedTools,
    pattern: input.pattern,
  })
  if (!why) return
  db()
    .query(
      `UPDATE run SET status='failed', error=?, mcp_error=?, failure_kind='mcp_unverified', latency_ms=? WHERE id=?`,
    )
    .run(why, why, Date.now() - input.started, input.runId)
  await input.resetSandbox()
  teardownTerminalRunResources(db(), input.runId)
  throw Object.assign(new Error(`run ${input.runId} could not start: ${why}`), {
    runId: input.runId,
  })
}
