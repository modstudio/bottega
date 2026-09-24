// concern: run-mcp-attachment-record
/** Adapts stored pre-launch evidence to the final worker attachment decision. */
import { db } from '../database/db.ts'
import type { StreamEvent } from '../events.ts'
import type { McpMode } from '../mcp/mcp-preflight.ts'
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
