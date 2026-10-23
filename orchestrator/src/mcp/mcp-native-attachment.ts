// concern: mcp-native-attachment
/** Pure native project-server attachment policy for routing and launch. */
import type { McpCompatibilityMode, RequiredMcpServer } from './mcp-compatibility.ts'

type NativeMcpAttachmentPrediction = {
  confirmable: boolean
  reason: string | null
}

export type McpTransportPinFacts = {
  pinnedTransport?: 'cli' | 'acp'
  transportPinSource?: 'explicit' | 'environment'
}

export type RequiredMcpAttachmentDecision = {
  confirmable: boolean
  routingIneligibility: string | null
  refusalReason: string | null
}

/** Predict the native project-server launch path, independently of a capability probe. */
function predictNativeMcpAttachment(input: {
  name: string
  harness?: string
  transport: 'cli' | 'acp'
}): NativeMcpAttachmentPrediction {
  const harness = input.harness ?? input.name
  // An ACP session launches with the launch's project selection, so a goose
  // ACP worker reaches the project servers the way a Codex CLI worker does.
  if (input.transport === 'acp') {
    if (harness === 'goose') return { confirmable: true, reason: null }
    return {
      confirmable: false,
      reason: `native project MCP attachment is unconfirmable: ${harness} ACP launch has no verified project-server attachment`,
    }
  }
  if (input.name === 'codex' || harness === 'grok') {
    return { confirmable: true, reason: null }
  }
  return {
    confirmable: false,
    reason: `native project MCP attachment is unconfirmable for ${harness} CLI`,
  }
}

function requiredMcpRemedy(pin: McpTransportPinFacts): string {
  if (pin.pinnedTransport !== 'acp') {
    return 're-dispatch on an agent that attaches natively (--agent codex) or drop --mcp'
  }
  return pin.transportPinSource === 'environment'
    ? 'unset BOTTEGA_TRANSPORT and re-dispatch with --transport cli, or drop --mcp'
    : 're-dispatch with --transport cli or drop --mcp'
}

/** Make the one required-attachment decision shared by routing and launch. */
function attachmentDecision(
  mode: McpCompatibilityMode | null | undefined,
  prediction: NativeMcpAttachmentPrediction,
  pin: McpTransportPinFacts,
): RequiredMcpAttachmentDecision {
  const reason =
    mode === 'require' && prediction.reason
      ? `${prediction.reason}; ${requiredMcpRemedy(pin)}`
      : null
  return {
    confirmable: prediction.confirmable,
    routingIneligibility: reason,
    refusalReason: reason,
  }
}

/** Bind a resolved project-server requirement to one agent and effective transport pin. */
export function decideRequiredMcpAttachment(
  agent: { name: string; harness?: string; defaultTransport: 'cli' | 'acp' },
  required: RequiredMcpServer | undefined,
  pin: McpTransportPinFacts = {},
): RequiredMcpAttachmentDecision {
  if (!required) {
    return { confirmable: true, routingIneligibility: null, refusalReason: null }
  }
  const transport = pin.pinnedTransport ?? agent.defaultTransport
  return attachmentDecision(
    required.mode,
    predictNativeMcpAttachment({ name: agent.name, harness: agent.harness, transport }),
    pin,
  )
}

export function requiredMcpIneligibility(
  agent: { name: string; harness?: string; defaultTransport: 'cli' | 'acp' },
  required: RequiredMcpServer | undefined,
  pin: McpTransportPinFacts = {},
): string | null {
  return decideRequiredMcpAttachment(agent, required, pin).routingIneligibility
}
