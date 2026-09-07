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
        content: { type: 'text', text: '"@devbox/orchestrator"' },
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
        content: { type: 'text', text: '@devbox/orchestrator' },
      },
    },
  ],
  stopReason: 'end_turn' as const,
  usage: { inputTokens: 101_394, outputTokens: 111, totalTokens: 101_505 },
}
