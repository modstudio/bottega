import { afterEach, expect, test } from 'bun:test'
import { db } from '../database/db.ts'
import {
  type AgentTransport,
  registerTransport,
  type TransportHandle,
  type TransportResult,
  type TransportStartOpts,
} from '../transport/transport.ts'
import { registerAcpTransport } from '../transport/transport-acp.ts'
import { EMPTY_VENDOR_USAGE } from '../transport/vendor-usage.ts'
import { probeAgent } from './agent-probe.ts'
import { addAgent } from './agent-registry.ts'

function result(events: TransportResult['events'], failed = false): TransportResult {
  return {
    output: failed ? 'no ping tool call' : 'ok',
    stdout: '',
    stderr: '',
    raw: '',
    parsed: null,
    tokens: null,
    costUsd: null,
    vendorUsage: EMPTY_VENDOR_USAGE,
    sessionId: null,
    stopReason: failed ? 'error' : 'end_turn',
    error: failed ? 'mcp turn failed' : null,
    exitCode: failed ? 1 : 0,
    pid: null,
    events,
    asking: false,
    failureKind: null,
    status: failed ? 'failed' : 'ok',
    questions: [],
  } as TransportResult
}

/** A fake ACP transport: answers every probe turn, and emits one MCP tool call only when the MCP turn asked to observe one. */
function fakeTransport(observation: 'observed' | 'failed'): AgentTransport {
  const handle = (opts: TransportStartOpts): TransportHandle => {
    const events: TransportResult['events'] = []
    if (opts.mcp && observation === 'observed')
      events.push({ kind: 'tool', status: 'completed', title: 'ping', toolKind: 'mcp' } as never)
    return {
      pid: null,
      kill() {},
      prompt: async () => {},
      async *events() {
        for (const event of events) yield event
      },
      cancel: async () => {},
      collect: async () => result(events, opts.mcp === true && observation === 'failed'),
    }
  }
  return {
    name: 'acp',
    canInjectMidTurn: false,
    configuredAsk: () => null,
    async start(opts) {
      return handle(opts)
    },
    prompt: (turn, text) => turn.prompt(text),
    events: (turn) => turn.events(),
    cancel: (turn) => turn.cancel(),
    async resume(opts) {
      return handle(opts)
    },
  }
}

function register(name: string): void {
  addAgent(name, {
    harness: 'goose',
    backend: 'vendor',
    model: 'fixture',
    transport: 'acp',
    jobs: ['file-question'],
  })
}

function caps(name: string): { mcp?: boolean } {
  return JSON.parse(
    (db().query('SELECT caps FROM agent WHERE name=?').get(name) as { caps: string }).caps,
  )
}

afterEach(() => registerAcpTransport())

test('a goose probe records the MCP capability it observed on a tool call', async () => {
  register('goose-probe-observed')
  registerTransport('acp', () => fakeTransport('observed'))
  await probeAgent('goose-probe-observed', { environment: {}, path: process.env.PATH })
  expect(caps('goose-probe-observed').mcp).toBe(true)
})

test('a goose probe whose MCP turn fails records no MCP capability', async () => {
  register('goose-probe-failed')
  registerTransport('acp', () => fakeTransport('failed'))
  await probeAgent('goose-probe-failed', { environment: {}, path: process.env.PATH })
  expect(caps('goose-probe-failed').mcp).toBe(false)
})
