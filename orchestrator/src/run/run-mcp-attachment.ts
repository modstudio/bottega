import { type McpConnection, type McpMode, mcpAttachRefusal } from '../mcp/mcp-preflight.ts'

export type CwdMcpPreflightFacts = {
  mcpMode: McpMode | null
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
  return Boolean(
    facts.mcpMode &&
      facts.callerCwdHasProject &&
      (facts.forbidsRepo || (facts.repoJob && facts.discoversMcpFromCwd)),
  )
}

export type McpAttachmentFacts = {
  connection: McpConnection | null
  mcpMode: McpMode | null
  writesJob: boolean
  agentHasMcp: boolean
}

export type McpAttachmentRuling = {
  refusalReason: string | null
  usingMcp: boolean
}

/** Decide attachment only after the caller has performed any required probe. */
export function decideMcpAttachment(facts: McpAttachmentFacts): McpAttachmentRuling {
  const refusal = facts.connection ? mcpAttachRefusal(facts.connection) : null
  return {
    refusalReason: facts.mcpMode === 'require' ? refusal : null,
    usingMcp:
      (Boolean(facts.mcpMode) || facts.writesJob) &&
      facts.agentHasMcp &&
      facts.connection?.connected !== false,
  }
}
