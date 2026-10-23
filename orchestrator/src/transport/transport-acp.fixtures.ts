import { PLATFORM_SLUG } from '../../../shared/brand.ts'

const ORCHESTRATOR_PACKAGE_NAME = `@${PLATFORM_SLUG}/orchestrator`

/**
 * ACP session-update fixtures, redacted from the 2026-09-06 parity run
 * against real codex-acp 1.10.0. Session ids and usage counts are generic;
 * the agent_message_chunk bodies match the recorded replies.
 */
export const ACP_FIXTURE_STRUCTURED_OK = {
  sessionId: 'sess_parity_ok',
  updates: [
    {
      sessionId: 'sess_parity_ok',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '{"status":"ok"}' },
      },
    },
    {
      sessionId: 'sess_parity_ok',
      update: { sessionUpdate: 'usage_update', used: 1200, size: 200000 },
    },
  ],
  stopReason: 'end_turn' as const,
}

export const ACP_FIXTURE_GOOSE_PROVIDER_USAGE = {
  sessionId: 'sess_goose_provider',
  updates: [
    {
      sessionId: 'sess_goose_provider',
      update: {
        sessionUpdate: 'usage_update',
        used: 90_000,
        contextLimit: 200_000,
        accumulatedInputTokens: 1_000,
        accumulatedOutputTokens: 200,
        accumulatedCost: 9.99,
      },
    },
    {
      sessionId: 'sess_goose_provider',
      update: {
        sessionUpdate: 'message_usage',
        messageId: 'message-1',
        usage: {
          inputTokens: 700,
          outputTokens: 100,
          totalTokens: 800,
          cost: 0.02,
          costSource: 'provider_reported',
        },
      },
    },
    {
      sessionId: 'sess_goose_provider',
      update: {
        sessionUpdate: 'message_usage',
        messageId: 'message-2',
        usage: {
          inputTokens: 300,
          outputTokens: 100,
          totalTokens: 400,
          cost: 0.01,
          costSource: 'provider_reported',
        },
      },
    },
    {
      sessionId: 'sess_goose_provider',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'done' },
      },
    },
  ],
  stopReason: 'end_turn' as const,
}

export const ACP_FIXTURE_GOOSE_ESTIMATED_USAGE = {
  sessionId: 'sess_goose_estimated',
  updates: [
    {
      update: {
        sessionUpdate: 'message_usage',
        messageId: 'message-1',
        usage: {
          inputTokens: 400,
          outputTokens: 40,
          cost: 0.04,
          costSource: 'estimated',
        },
      },
    },
    {
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'done' },
      },
    },
  ],
  stopReason: 'end_turn' as const,
}

export const ACP_FIXTURE_TOOL_READ = {
  sessionId: 'sess_parity_read',
  updates: [
    {
      sessionId: 'sess_parity_read',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'call_1',
        title: 'Read orchestrator/package.json',
        kind: 'read',
        status: 'completed',
      },
    },
    {
      sessionId: 'sess_parity_read',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `"${ORCHESTRATOR_PACKAGE_NAME}"` },
      },
    },
    {
      sessionId: 'sess_parity_read',
      update: { sessionUpdate: 'usage_update', used: 3400, size: 200000 },
    },
  ],
  stopReason: 'end_turn' as const,
}

export const ACP_FIXTURE_SCHEMA = {
  sessionId: 'sess_parity_schema',
  updates: [
    {
      sessionId: 'sess_parity_schema',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '{"verdict":"true"}' },
      },
    },
  ],
  stopReason: 'end_turn' as const,
}

export const ACP_FIXTURE_TIMEOUT = {
  sessionId: 'sess_parity_timeout',
  updates: [
    {
      sessionId: 'sess_parity_timeout',
      update: {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'planning' },
      },
    },
  ],
  stopReason: 'cancelled' as const,
  timedOut: true,
}

export const ACP_FIXTURE_MALFORMED = {
  sessionId: 'sess_parity_malformed',
  updates: [
    {
      sessionId: 'sess_parity_malformed',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '{' },
      },
    },
  ],
  stopReason: 'end_turn' as const,
}

export const ACP_FIXTURE_ELICITATION = {
  sessionId: 'sess_parity_ask',
  updates: [],
  elicitation: { message: 'Which of the two designs should I implement?' },
  stopReason: 'cancelled' as const,
}

export const ACP_FIXTURE_TRUNCATED = {
  sessionId: 'sess_parity_trunc',
  updates: [],
  stopReason: 'max_tokens' as const,
}

export const ACP_FIXTURE_TRUNCATED_TEXT = {
  sessionId: 'sess_parity_trunc_text',
  updates: [
    {
      sessionId: 'sess_parity_trunc_text',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'partial answer' },
      },
    },
  ],
  stopReason: 'max_tokens' as const,
}

export const ACP_FIXTURE_CANCELLED_TEXT = {
  sessionId: 'sess_parity_cancel_text',
  updates: [
    {
      sessionId: 'sess_parity_cancel_text',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'partial before cancel' },
      },
    },
  ],
  stopReason: 'cancelled' as const,
}

export const ACP_FIXTURE_REFUSAL = {
  sessionId: 'sess_parity_refusal',
  updates: [],
  stopReason: 'refusal' as const,
}

/** Redacted Goose/OpenRouter provider error delivered as the failed ACP prompt payload. */
export const ACP_FIXTURE_RATE_LIMIT = {
  sessionId: 'sess_goose_rate_limit',
  updates: [],
  stopReason: null,
  error:
    '{"error":{"code":429,"message":"Rate limit exceeded: free-models-per-day limit reached"}}',
}

export const ACP_FIXTURE_EDIT_PERMISSION = {
  toolKind: 'edit' as const,
  title: 'Edit src/run.ts',
  options: [
    { optionId: 'allow-once', kind: 'allow_once' },
    { optionId: 'reject-once', kind: 'reject_once' },
  ],
}

/** Redacted from grok 1.0.13 `agent stdio`; usage is on the prompt response. */
export const ACP_FIXTURE_GROK = {
  sessionId: 'sess_grok_read',
  updates: [
    {
      sessionId: 'sess_grok_read',
      update: {
        sessionUpdate: 'tool_call',
        title: 'read_file',
        _meta: { 'x.ai/tool': { kind: 'read' } },
      },
    },
    {
      sessionId: 'sess_grok_read',
      update: {
        sessionUpdate: 'tool_call_update',
        title: 'Read orchestrator/package.json',
        kind: 'read',
        status: 'completed',
      },
    },
    {
      sessionId: 'sess_grok_read',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: ORCHESTRATOR_PACKAGE_NAME },
      },
    },
  ],
  stopReason: 'end_turn' as const,
  usage: { inputTokens: 101_394, outputTokens: 111, totalTokens: 101_505 },
}
