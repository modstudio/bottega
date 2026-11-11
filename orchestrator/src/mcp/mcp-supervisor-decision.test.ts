import { describe, expect, test } from 'bun:test'
import {
  initialMcpSupervisorState,
  JsonLineDecoder,
  MCP_SERVER_CRASH_LOOP_CEILING,
  MCP_SERVER_RESTART_BACKOFF_MS,
  MCP_SERVER_STALE_EXIT,
  MCP_SERVER_SHUTDOWN_WAIT_MS,
  MCP_SUPERVISOR_ID_PREFIX,
  type McpSupervisorEvent,
  type McpSupervisorState,
  reduceMcpSupervisor,
} from './mcp-supervisor-decision.ts'

const request = (id: string | number, method = 'tools/call') => ({
  jsonrpc: '2.0',
  id,
  method,
  params: {},
})
const notification = (method: string) => ({ jsonrpc: '2.0', method })
const response = (id: string | number) => ({ jsonrpc: '2.0', id, result: {} })

function transition(state: McpSupervisorState, event: McpSupervisorEvent) {
  return reduceMcpSupervisor(state, event)
}

function establishedState(): McpSupervisorState {
  let state = initialMcpSupervisorState()
  state = transition(state, { type: 'client-message', message: request(1, 'initialize') }).state
  state = transition(state, { type: 'child-message', message: response(1) }).state
  state = transition(state, {
    type: 'client-message',
    message: notification('notifications/initialized'),
  }).state
  return state
}

describe('MCP supervisor decision', () => {
  test('answers an in-flight call instead of replaying it after the child exits', () => {
    let state = establishedState()
    state = transition(state, { type: 'client-message', message: request('call-1') }).state

    const exited = transition(state, {
      type: 'child-exit',
      code: 1,
      status: 'exit status 1',
      at: 1_000,
    })

    expect(exited.actions[0]).toEqual({
      type: 'send-client',
      message: {
        jsonrpc: '2.0',
        id: 'call-1',
        error: {
          code: -32000,
          message: 'Bottega MCP server restarted; this call may be retried.',
        },
      },
    })
    expect(exited.actions).not.toContainEqual({ type: 'send-child', message: request('call-1') })
  })

  test('replays and swallows the handshake before ordered buffered messages and list_changed', () => {
    const exited = transition(establishedState(), {
      type: 'child-exit',
      code: MCP_SERVER_STALE_EXIT,
      status: `exit status ${MCP_SERVER_STALE_EXIT}`,
      at: 2_000,
    })
    expect(exited.actions[0]).toEqual({ type: 'start-child' })
    const replay = exited.actions[1]
    expect(replay).toMatchObject({
      type: 'send-child',
      message: { method: 'initialize' },
    })
    if (replay?.type !== 'send-child') throw new Error('expected replayed initialize')
    const replayId = replay.message.id
    expect(replayId).toBe(`${MCP_SUPERVISOR_ID_PREFIX}1`)

    let state = transition(exited.state, {
      type: 'client-message',
      message: request('buffered-1'),
    }).state
    state = transition(state, {
      type: 'client-message',
      message: request('buffered-2', 'tools/list'),
    }).state
    const completed = transition(state, {
      type: 'child-message',
      message: response(replayId as string),
    })

    expect(completed.actions).toEqual([
      { type: 'send-child', message: notification('notifications/initialized') },
      { type: 'send-child', message: request('buffered-1') },
      { type: 'send-child', message: request('buffered-2', 'tools/list') },
      {
        type: 'send-client',
        message: { jsonrpc: '2.0', method: 'notifications/tools/list_changed' },
      },
    ])
    expect(completed.actions).not.toContainEqual({
      type: 'send-client',
      message: response(replayId as string),
    })
    expect(completed.state.inFlight).toEqual(['buffered-1', 'buffered-2'])
  })

  test('restarts stale children immediately and backs off other exits', () => {
    const stale = transition(initialMcpSupervisorState(), {
      type: 'child-exit',
      code: MCP_SERVER_STALE_EXIT,
      status: `exit status ${MCP_SERVER_STALE_EXIT}`,
      at: 1,
    })
    expect(stale.actions[0]).toEqual({ type: 'start-child' })

    const crashed = transition(initialMcpSupervisorState(), {
      type: 'child-exit',
      code: 1,
      status: 'exit status 1',
      at: 1,
    })
    expect(crashed.actions).toEqual([
      {
        type: 'schedule',
        kind: 'restart',
        delayMs: MCP_SERVER_RESTART_BACKOFF_MS,
        token: 1,
      },
    ])
    expect(
      transition(crashed.state, { type: 'timer', kind: 'restart', token: 1 }).actions[0],
    ).toEqual({ type: 'start-child' })
  })

  test('stops a crash loop and refuses every later request with the remedy', () => {
    let state = initialMcpSupervisorState()
    for (let index = 0; index <= MCP_SERVER_CRASH_LOOP_CEILING; index += 1) {
      state = transition(state, {
        type: 'child-exit',
        code: MCP_SERVER_STALE_EXIT,
        status: `exit status ${MCP_SERVER_STALE_EXIT}`,
        at: index,
      }).state
    }

    for (const id of ['later-1', 'later-2']) {
      const refused = transition(state, { type: 'client-message', message: request(id) })
      expect(refused.actions).toHaveLength(1)
      expect(refused.actions[0]).toMatchObject({
        type: 'send-client',
        message: { id, error: { code: -32000 } },
      })
      expect(JSON.stringify(refused.actions[0])).toContain(`exit status ${MCP_SERVER_STALE_EXIT}`)
      expect(JSON.stringify(refused.actions[0])).toContain(
        'run bottega machine doctor, then reconnect the server in the harness',
      )
    }
  })

  test('closes the child and exits zero when the client closes', () => {
    const closing = transition(initialMcpSupervisorState(), { type: 'client-close' })
    expect(closing.actions).toEqual([
      { type: 'close-child-input' },
      {
        type: 'schedule',
        kind: 'shutdown',
        delayMs: MCP_SERVER_SHUTDOWN_WAIT_MS,
        token: 1,
      },
    ])
    expect(
      transition(closing.state, {
        type: 'child-exit',
        code: 0,
        status: 'exit status 0',
        at: 1,
      }).actions,
    ).toEqual([{ type: 'exit', code: 0 }])
  })

  test('splits newline-framed JSON across chunks', () => {
    const decoder = new JsonLineDecoder()
    expect(decoder.push('{"jsonrpc":"2.0",')).toEqual([])
    expect(decoder.push('"id":1}\n\n{"jsonrpc":"2.0","id":2}\n')).toEqual([
      { jsonrpc: '2.0', id: 1 },
      { jsonrpc: '2.0', id: 2 },
    ])
  })
})
