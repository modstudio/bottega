import {
  type McpConnection,
  type McpMode,
  type McpRequest,
  mcpAttachRefusal,
  requestedMcpMode,
} from '../mcp/mcp-preflight.ts'
import { type McpProbeResult, mcpCallEvidence, wrongProjectReason } from '../mcp/mcp-probe.ts'

export type CwdMcpPreflightFacts = {
  mcpRequest: McpRequest | undefined
  callerCwdHasProject: boolean
  forbidsRepo: boolean
  repoJob: boolean
  discoversMcpFromCwd: boolean
}

/**
 * Probe after routing: a failed doctor is evidence about the selected agent.
 * Agents that discover MCP from cwd must be probed later, against the worker
 * tree they will actually inspect; all others retain the pre-row path.
 */
export function shouldDeferCwdMcpPreflight(facts: CwdMcpPreflightFacts): boolean {
  const mcpMode = requestedMcpMode(facts.mcpRequest)
  return Boolean(
    mcpMode &&
      facts.callerCwdHasProject &&
      (facts.forbidsRepo || (facts.repoJob && facts.discoversMcpFromCwd)),
  )
}

export type McpAttachmentFacts = {
  connection: McpConnection | null
  mcpRequest: McpRequest | undefined
  writesJob: boolean
  agentHasMcp: boolean
}

export type McpAttachmentRuling = {
  mcpMode: McpMode | null
  refusalReason: string | null
  usingMcp: boolean
}

/** Decide attachment only after the caller has performed any required probe. */
export function decideMcpAttachment(facts: McpAttachmentFacts): McpAttachmentRuling {
  const mcpMode = requestedMcpMode(facts.mcpRequest)
  const refusal = facts.connection ? mcpAttachRefusal(facts.connection) : null
  return {
    mcpMode,
    refusalReason: mcpMode === 'require' ? refusal : null,
    usingMcp:
      (Boolean(mcpMode) || facts.writesJob) &&
      facts.agentHasMcp &&
      facts.connection?.connected !== false,
  }
}

export type McpMirrorMismatch = {
  recorded: McpProbeResult
  connection: McpConnection
  refusalReason: string | null
  continuedConnection: McpConnection
}

/** Decide the attachment outcome when the worker tree has no launch definition. */
export function decideMcpMirrorMismatch(
  server: string,
  namesSeen: string[],
  mcpMode: McpMode | null,
): McpMirrorMismatch | null {
  const error = wrongProjectReason(server, namesSeen)
  if (!error) return null
  const connection: McpConnection = { server, connected: false, error, namesSeen }
  return {
    recorded: {
      server,
      tool: 'tools/list',
      ok: false,
      error,
      durationMs: 0,
      detail: null,
      namesSeen,
    },
    connection,
    refusalReason: mcpMode === 'require' ? mcpAttachRefusal(connection) : null,
    continuedConnection: { ...connection, error: `mirror: ${error}` },
  }
}

export type McpToolProbeRuling = {
  callEvidence: ReturnType<typeof mcpCallEvidence>
  refusalReason: string | null
  failedConnection: McpConnection | null
}

/** Translate a completed tool probe into attachment policy; the caller records and enforces it. */
export function decideMcpToolProbe(
  probe: McpProbeResult,
  server: string,
  mcpMode: McpMode | null,
  agent: string,
  projectName: string | null,
): McpToolProbeRuling {
  const callEvidence = mcpCallEvidence(probe)
  const refusalReason =
    callEvidence.connected !== 1 && mcpMode === 'require'
      ? callEvidence.connected === 0
        ? `MCP tool call failed on ${server}: ${callEvidence.error}`
        : `mcp unverifiable on ${agent}: ${callEvidence.error}` +
          `\ninvariant: --mcp means a proven tool call, never a handshake` +
          `\ncleared by: orch project set ${projectName ?? '<project>'} --settings '{"mcp":{"probe_tool":"<a cheap read tool on ${server}>"}}'`
      : null
  return {
    callEvidence,
    refusalReason,
    failedConnection: probe.ok
      ? null
      : {
          server,
          connected: false,
          error: probe.error,
          namesSeen: probe.namesSeen,
        },
  }
}
