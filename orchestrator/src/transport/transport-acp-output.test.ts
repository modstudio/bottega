import { expect, test } from 'bun:test'
import { normalizeAcpTurn } from './transport-acp.ts'

test('per-update text output concatenates to the full mixed turn output', () => {
  const updates = [
    {
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'I will inspect ' },
      },
    },
    {
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'call-1',
        title: 'Read package.json',
        kind: 'read',
        status: 'pending',
        locations: [{ path: '/tmp/repo/package.json' }],
      },
    },
    {
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-1',
        status: 'in_progress',
      },
    },
    {
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-1',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: '{"name":"app"}' } }],
      },
    },
    {
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'the manifest.' },
      },
    },
    {
      update: {
        sessionUpdate: 'message_usage',
        usage: { inputTokens: 120, outputTokens: 18 },
      },
    },
  ]

  const perUpdateOutput = updates
    .map((update) => normalizeAcpTurn({ sessionId: 'sess_mixed', updates: [update] }).output)
    .join('')

  expect(perUpdateOutput).toBe(normalizeAcpTurn({ sessionId: 'sess_mixed', updates }).output)
})
