import { expect, test } from 'bun:test'
import { TOOL_EVENT_TEXT_CHARS } from '../tool-event-text.ts'
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

test('a shell tool call records its command instead of compact JSON', () => {
  const result = normalizeAcpTurn({
    updates: [
      {
        update: {
          sessionUpdate: 'tool_call',
          title: 'shell',
          rawInput: { command: 'git status --short' },
        },
      },
    ],
  })

  expect(result.events).toContainEqual(
    expect.objectContaining({ kind: 'tool', title: 'shell', input: 'git status --short' }),
  )
})

test('a long tool input is capped with a marker', () => {
  const result = normalizeAcpTurn({
    updates: [
      {
        update: {
          sessionUpdate: 'tool_call',
          title: 'shell',
          rawInput: { command: 'x'.repeat(TOOL_EVENT_TEXT_CHARS + 100) },
        },
      },
    ],
  })
  const event = result.events.find((item) => item.kind === 'tool')

  expect(event?.kind === 'tool' ? event.input : undefined).toHaveLength(TOOL_EVENT_TEXT_CHARS)
  expect(event?.kind === 'tool' ? event.input : undefined).toEndWith('… [truncated]')
})
