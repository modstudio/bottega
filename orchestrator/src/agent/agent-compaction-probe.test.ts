import { expect, test } from 'bun:test'
import {
  GOOSE_COMPACTION_PROBE_CONTEXT_LIMIT,
  probeAgentCompacts,
} from './agent-compaction-probe.ts'

test('the second Goose turn forces compaction and a continued session passes', async () => {
  const turns: Array<{ prompt: string; session?: string; environment: Record<string, string> }> = []
  const result = await probeAgentCompacts(async (turn) => {
    turns.push(turn)
    return turn.session
      ? {
          status: 'ok',
          output: 'GOOSE_COMPACTION_PROBE_OK',
          sessionId: turn.session,
        }
      : { status: 'ok', output: 'ready', sessionId: 'session-1' }
  })

  expect(result.ok).toBe(true)
  expect(turns).toHaveLength(2)
  expect(turns[1]!.session).toBe('session-1')
  expect(turns[1]!.prompt.split('x ').length - 1).toBe(8_000)
  expect(turns[1]!.environment).toEqual({
    GOOSE_CONTEXT_LIMIT: String(GOOSE_COMPACTION_PROBE_CONTEXT_LIMIT),
    GOOSE_AUTO_COMPACT_THRESHOLD: '0.8',
    GOOSE_TOOL_PAIR_SUMMARIZATION: 'false',
  })
})

test('a Goose compaction refusal records the capability as false', async () => {
  const result = await probeAgentCompacts(async (turn) =>
    turn.session
      ? {
          status: 'failed',
          output: 'Ran into this error trying to compact: provider refused',
          sessionId: turn.session,
        }
      : { status: 'ok', output: 'ready', sessionId: 'session-1' },
  )

  expect(result).toEqual({
    ok: false,
    output: 'Ran into this error trying to compact: provider refused',
  })
})

test('a transient provider error leaves the compaction capability absent', async () => {
  const result = await probeAgentCompacts(async (turn) =>
    turn.session
      ? {
          status: 'failed',
          output: 'Provider rate limit exceeded',
          sessionId: turn.session,
        }
      : { status: 'ok', output: 'ready', sessionId: 'session-1' },
  )

  expect(result).toEqual({
    ok: null,
    output:
      'Compaction capability unestablished: second turn failed outside compaction: Provider rate limit exceeded',
  })
})

test('a first-turn failure leaves the compaction capability absent', async () => {
  const result = await probeAgentCompacts(async () => ({
    status: 'failed',
    output: 'Provider unavailable',
    sessionId: null,
  }))

  expect(result).toEqual({
    ok: null,
    output: 'Compaction capability unestablished: first turn failed: Provider unavailable',
  })
})

test('a first-turn Goose compaction refusal records the capability as false', async () => {
  const result = await probeAgentCompacts(async () => ({
    status: 'failed',
    output: 'Ran into this error trying to compact: provider refused',
    sessionId: null,
  }))

  expect(result).toEqual({
    ok: false,
    output: 'Ran into this error trying to compact: provider refused',
  })
})
