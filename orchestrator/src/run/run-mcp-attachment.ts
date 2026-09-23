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

export type WorkerMcpEvent = {
  kind: string
  toolKind?: string
  server?: string
  title?: string
  status?: string
  error?: string
}

export type FinalMcpFacts<FailureKind extends string> = {
  requiredServer: string
  mcpMode: McpMode | null
  preLaunchEvidence: McpConnection | null
  workerEvents: readonly WorkerMcpEvent[]
  outcome: {
    status: string
    error: string | null
    failureKind: FailureKind | null
  }
}

export type FinalMcpRuling<FailureKind extends string> = {
  connected: 0 | 1 | null
  error: string | null
  outcome: {
    status: string
    error: string | null
    failureKind: FailureKind | 'mcp_unverified' | null
  }
}

/** Decide final connection evidence from the worker's structured stream, never its prose. */
export function decideFinalMcpConnection<FailureKind extends string>(
  facts: FinalMcpFacts<FailureKind>,
): FinalMcpRuling<FailureKind> {
  const calls = facts.workerEvents.filter(
    (event) =>
      event.kind === 'tool' && event.toolKind === 'mcp' && event.server === facts.requiredServer,
  )
  const completed = calls.find((event) => event.status === 'completed')
  if (completed) {
    return {
      connected: 1,
      error: `verified: worker tool call ${facts.requiredServer}.${completed.title ?? 'unknown'}`,
      outcome: facts.outcome,
    }
  }
  const failed = calls.find((event) => event.status === 'failed')
  if (failed) {
    const reason = failed.error ?? 'MCP tool call failed'
    const outcome =
      facts.mcpMode === 'require' && facts.outcome.status === 'ok'
        ? {
            status: 'failed',
            failureKind: 'mcp_unverified' as const,
            error: `MCP server '${facts.requiredServer}' was unreachable to the worker: ${reason}`,
          }
        : facts.outcome
    return { connected: 0, error: reason, outcome }
  }
  return {
    connected: facts.preLaunchEvidence?.connected === false ? 0 : null,
    error: facts.preLaunchEvidence?.error ?? null,
    outcome: facts.outcome,
  }
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
  const orchProbeReachedTool = probe.ok && probe.tool !== 'tools/list'
  const refusalReason =
    !orchProbeReachedTool && mcpMode === 'require'
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
