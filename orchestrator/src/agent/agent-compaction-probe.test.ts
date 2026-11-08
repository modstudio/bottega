import { expect, test } from 'bun:test'
import { probeAgentCompacts } from './agent-compaction-probe.ts'

test('the second Goose turn forces compaction and a continued session passes', async () => {
  const turns: Array<{ prompt: string; session?: string; environment: Record<string, string> }> = []
  const result = await probeAgentCompacts(async (turn) => {
    turns.push(turn)
    return turn.session
      ? {
          status: 'ok',
          output: 'GOOSE_COMPACTION_PROBE_OK',
          sessionId: turn.session,
          compactions: 1,
        }
      : { status: 'ok', output: 'ready', sessionId: 'session-1', compactions: 0 }
  })

  expect(result.ok).toBe(true)
  expect(turns).toHaveLength(2)
  expect(turns[1]!.session).toBe('session-1')
})

test('successful turns without a compaction ledger row leave the capability absent', async () => {
  const result = await probeAgentCompacts(async (turn) =>
    turn.session
      ? {
          status: 'ok',
          output: 'GOOSE_COMPACTION_PROBE_OK',
          sessionId: turn.session,
          compactions: 0,
        }
      : { status: 'ok', output: 'ready', sessionId: 'session-1', compactions: 0 },
  )

  expect(result).toEqual({
    ok: null,
    output: 'Compaction capability unestablished: no compaction observed',
  })
})

test('a Goose compaction refusal records the capability as false', async () => {
  const result = await probeAgentCompacts(async (turn) =>
    turn.session
      ? {
          status: 'failed',
          output: 'Ran into this error trying to compact: provider refused',
          sessionId: turn.session,
          compactions: null,
        }
      : { status: 'ok', output: 'ready', sessionId: 'session-1', compactions: 0 },
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
          compactions: null,
        }
      : { status: 'ok', output: 'ready', sessionId: 'session-1', compactions: 0 },
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
    compactions: null,
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
    compactions: null,
  }))

  expect(result).toEqual({
    ok: false,
    output: 'Ran into this error trying to compact: provider refused',
  })
})
