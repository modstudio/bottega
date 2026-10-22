import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  decideRequiredMcpAttachment,
  type McpTransportPinFacts,
  predictNativeMcpAttachment,
} from '../mcp/mcp-native-attachment.ts'
import {
  type McpConnection,
  type McpMode,
  type McpRequest,
  mcpAttachRefusal,
  requestedMcpMode,
} from '../mcp/mcp-preflight.ts'
import { type McpProbeResult, mcpCallEvidence, wrongProjectReason } from '../mcp/mcp-probe.ts'

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

export type McpLaunchRuling = {
  agentHasMcp: boolean
  refusalReason: string | null
}

/** Decide native project-server availability before any stack or probe work begins. */
export function decideMcpLaunchRuling(
  request: McpRequest | undefined,
  agent: { name: string; harness?: string; caps: { mcp: boolean } },
  transport: 'cli' | 'acp',
  pin: McpTransportPinFacts,
): McpLaunchRuling {
  const mode = requestedMcpMode(request)
  if (!mode) return { agentHasMcp: agent.caps.mcp, refusalReason: null }
  const attachment = decideRequiredMcpAttachment({
    mode,
    prediction: predictNativeMcpAttachment({
      name: agent.name,
      harness: agent.harness,
      transport,
    }),
    pin,
  })
  return {
    agentHasMcp: attachment.confirmable,
    refusalReason: mode === 'require' ? attachment.refusalReason : null,
  }
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

type WorkerMcpEvent = {
  kind: string
  toolKind?: string
  server?: string
  title?: string
  status?: string
  error?: string
}

type FinalMcpFacts = {
  requiredServer: string
  mcpMode: McpMode | null
  preLaunchEvidence: McpConnection | null
  workerEvents: readonly WorkerMcpEvent[]
}

type FinalMcpRuling = {
  connected: 0 | 1 | null
  error: string | null
  requiredFailure: string | null
}

/** Decide final connection evidence from the worker's structured stream, never its prose. */
export function decideFinalMcpConnection(facts: FinalMcpFacts): FinalMcpRuling {
  const calls = facts.workerEvents.filter(
    (event) =>
      event.kind === 'tool' && event.toolKind === 'mcp' && event.server === facts.requiredServer,
  )
  const completed = calls.find((event) => event.status === 'completed')
  if (completed) {
    return {
      connected: 1,
      error: `verified: worker tool call ${facts.requiredServer}.${completed.title ?? 'unknown'}`,
      requiredFailure: null,
    }
  }
  const failed = calls.find((event) => event.status === 'failed')
  if (failed) {
    const reason = failed.error ?? 'MCP tool call failed'
    return {
      connected: 0,
      error: reason,
      requiredFailure:
        facts.mcpMode === 'require'
          ? `MCP server '${facts.requiredServer}' was unreachable to the worker: ${reason}`
          : null,
    }
  }
  return {
    connected: facts.preLaunchEvidence?.connected === false ? 0 : null,
    error: facts.preLaunchEvidence?.error ?? null,
    requiredFailure: null,
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
          `\ncleared by: ${PLATFORM_SLUG} project set ${projectName ?? '<project>'} --settings '{"mcp":{"probe_tool":"<a cheap read tool on ${server}>"}}'`
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
