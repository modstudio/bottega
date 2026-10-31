import { describe, expect, test } from 'bun:test'
import { registrationProbeReadsRepo } from '../agent/agent-probe.ts'
import { normalizeAcpTurn, observeAcpUpdate } from './transport-acp.ts'

describe('tool_call_update folds into its tool_call', () => {
  test('session/load replay before prompting publishes no live tool starts', () => {
    const published: unknown[] = []
    const updates: unknown[] = []
    for (let index = 0; index < 240; index++) {
      observeAcpUpdate(
        {
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: `replay-${index}`,
            title: 'replayed call',
          },
        },
        updates,
        '/dev/null',
        'loaded-session',
        (event) => published.push(event),
        'unknown',
        false,
      )
      observeAcpUpdate(
        {
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: `replay-${index}`,
            status: 'completed',
          },
        },
        updates,
        '/dev/null',
        'loaded-session',
        (event) => published.push(event),
        'unknown',
        false,
      )
    }
    expect(published).toEqual([])
  })

  test('a goose-shaped read (call with target, update with only the status) satisfies the readsRepo probe gate', () => {
    const result = normalizeAcpTurn({
      sessionId: 's',
      stopReason: 'end_turn',
      updates: [
        {
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'call-1',
            title: 'read probe.txt',
            kind: 'read',
            status: 'pending',
            locations: [{ path: '/tmp/probe/probe.txt' }],
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
            rawOutput: 'REGISTRATION_PROBE_FILE_OK',
          },
        },
        {
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'The contents are REGISTRATION_PROBE_FILE_OK' },
          },
        },
      ],
    })
    const tools = result.events.filter((event) => event.kind === 'tool')
    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({
      phase: 'start',
      status: 'completed',
      toolKind: 'read',
      target: '/tmp/probe/probe.txt',
      result: 'REGISTRATION_PROBE_FILE_OK',
    })
    expect(registrationProbeReadsRepo(result.events, result.output)).toBe(true)
  })

  test('an update naming no known call stays an update event, and an unrelated tool plus a hallucinated output without the sentinel still fails the gate', () => {
    const result = normalizeAcpTurn({
      sessionId: 's',
      stopReason: 'end_turn',
      updates: [
        {
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'call-9',
            title: 'list directory',
            kind: 'execute',
            status: 'completed',
          },
        },
        {
          update: { sessionUpdate: 'tool_call_update', toolCallId: 'orphan', status: 'completed' },
        },
        {
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'I listed the directory' },
          },
        },
      ],
    })
    expect(
      result.events.filter((event) => event.kind === 'tool').map((event) => event.phase),
    ).toEqual(['start', 'update'])
    expect(registrationProbeReadsRepo(result.events, result.output)).toBe(false)
  })
})
