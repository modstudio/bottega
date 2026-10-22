// concern: mcp-compatibility
/** Pure decisions for harness/server tool-name compatibility. */

export type McpCompatibilityVerdict = 'compatible' | 'partial' | 'incompatible' | 'unknown'

export type McpCompatibilityMode = 'require' | 'prefer'

export type RequiredMcpServer = {
  projectId: string
  project: string
  server: string
  mode: McpCompatibilityMode
  transport?: 'cli' | 'acp'
}

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

function mcpIncompatibilityReason(input: {
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

export type McpGrammarRuling = {
  routingIneligibility: string | null
  refusal: string | null
  failedConnection: string | null
}

export type NativeMcpAttachmentPrediction = {
  confirmable: boolean
  reason: string | null
}

/** Predict the native project-server launch path, independently of a capability probe. */
export function predictNativeMcpAttachment(input: {
  name: string
  harness?: string
  transport: 'cli' | 'acp'
}): NativeMcpAttachmentPrediction {
  if (input.transport === 'acp') {
    return {
      confirmable: false,
      reason:
        'native project MCP attachment is unconfirmable: ACP session launch does not attach project servers',
    }
  }
  const harness = input.harness ?? input.name
  if (input.name === 'codex' || harness === 'grok') {
    return { confirmable: true, reason: null }
  }
  return {
    confirmable: false,
    reason: `native project MCP attachment is unconfirmable for ${harness} CLI`,
  }
}

export function requiredMcpIneligibility(
  agent: { name: string; harness?: string; defaultTransport: 'cli' | 'acp' },
  required: RequiredMcpServer | undefined,
): string | null {
  if (required?.mode !== 'require') return null
  return predictNativeMcpAttachment({
    name: agent.name,
    harness: agent.harness,
    transport: required.transport ?? agent.defaultTransport,
  }).reason
}

/** Apply request mode to one observed tool-name compatibility result. */
export function decideMcpGrammarRuling(input: {
  mode: McpCompatibilityMode
  server: string
  listedTools: string[] | undefined
  pattern?: string
}): McpGrammarRuling {
  const compatible = { routingIneligibility: null, refusal: null, failedConnection: null }
  if (!input.pattern) return compatible
  const compatibility = decideMcpCompatibility(input.listedTools, input.pattern)
  if (compatibility.verdict !== 'incompatible') return compatible
  const reason = mcpIncompatibilityReason({
    server: input.server,
    pattern: input.pattern,
    compatibility,
  })
  if (input.mode === 'prefer') {
    return { routingIneligibility: null, refusal: null, failedConnection: reason }
  }
  return {
    routingIneligibility: reason,
    refusal: `${reason}; re-dispatch to route to a compatible agent`,
    failedConnection: null,
  }
}
