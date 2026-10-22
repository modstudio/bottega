// concern: mcp-native-attachment
/** Pure native project-server attachment policy for routing and launch. */
import type { McpCompatibilityMode, RequiredMcpServer } from './mcp-compatibility.ts'

export type NativeMcpAttachmentPrediction = {
  confirmable: boolean
  reason: string | null
}

export type McpTransportPinFacts = {
  transport?: 'cli' | 'acp'
  source?: 'explicit' | 'environment'
}

export type RequiredMcpAttachmentDecision = {
  confirmable: boolean
  routingIneligibility: string | null
  refusalReason: string | null
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
        'native project MCP attachment is unconfirmable: ACP session launch attaches only the ask server, not project servers',
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

function requiredMcpRemedy(pin: McpTransportPinFacts): string {
  if (pin.transport !== 'acp') {
    return 're-dispatch on an agent that attaches natively (--agent codex) or drop --mcp'
  }
  return pin.source === 'environment'
    ? 'unset ORCH_TRANSPORT and re-dispatch with --transport cli, or drop --mcp'
    : 're-dispatch with --transport cli or drop --mcp'
}

/** Make the one required-attachment decision shared by routing and launch. */
export function decideRequiredMcpAttachment(input: {
  mode: McpCompatibilityMode | null | undefined
  prediction: NativeMcpAttachmentPrediction
  pin: McpTransportPinFacts
}): RequiredMcpAttachmentDecision {
  const reason =
    input.mode === 'require' && input.prediction.reason
      ? `${input.prediction.reason}; ${requiredMcpRemedy(input.pin)}`
      : null
  return {
    confirmable: input.prediction.confirmable,
    routingIneligibility: reason,
    refusalReason: reason,
  }
}

export function requiredMcpIneligibility(
  agent: { name: string; harness?: string; defaultTransport: 'cli' | 'acp' },
  required: RequiredMcpServer | undefined,
  pin: McpTransportPinFacts = {},
): string | null {
  const transport = pin.transport ?? agent.defaultTransport
  return decideRequiredMcpAttachment({
    mode: required?.mode,
    prediction: predictNativeMcpAttachment({
      name: agent.name,
      harness: agent.harness,
      transport,
    }),
    pin,
  }).routingIneligibility
}
