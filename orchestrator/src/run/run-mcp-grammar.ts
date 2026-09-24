// concern: run-mcp-grammar
/** Owns the pre-launch grammar backstop. */

import { decideMcpGrammarRuling } from '../mcp/mcp-compatibility.ts'
import type { McpConnection, McpMode } from '../mcp/mcp-preflight.ts'
import type { McpProbeResult } from '../mcp/mcp-probe.ts'
import { refuseUnstartedRun } from './run-prelaunch-refusal.ts'

export async function enforceRunMcpGrammar(input: {
  server: string
  mode: McpMode
  pattern?: string
  probe: McpProbeResult
  runId: number
  started: number
  resetSandbox(): Promise<void>
}): Promise<McpConnection | null> {
  const ruling = decideMcpGrammarRuling({
    mode: input.mode,
    server: input.server,
    listedTools: input.probe.listedTools,
    pattern: input.pattern,
  })
  if (ruling.failedConnection) {
    return {
      server: input.server,
      connected: false,
      error: ruling.failedConnection,
      namesSeen: input.probe.namesSeen,
    }
  }
  if (!ruling.refusal) return null
  return refuseUnstartedRun({
    runId: input.runId,
    started: input.started,
    why: ruling.refusal,
    mcpError: ruling.refusal,
    resetSandbox: input.resetSandbox,
  })
}
