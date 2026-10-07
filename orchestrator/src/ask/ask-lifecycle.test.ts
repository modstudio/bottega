import { describe, expect, test } from 'bun:test'
import type { RunLogEvent } from '../events.ts'
import { summarizeAskServer } from './ask-lifecycle.ts'

const expected: RunLogEvent = {
  ts: 't1',
  type: 'ask_expected',
  transport: 'host',
  command: ['/old/bun', 'ask-server'],
}
const started: RunLogEvent = { ts: 't2', type: 'ask_started', tools: ['ask_orchestrator'] }
const initialized: RunLogEvent = { ts: 't3', type: 'ask_initialized' }
const listed: RunLogEvent = { ts: 't4', type: 'ask_listed', tools: ['ask_orchestrator'] }
const lifecycle = [expected, started, initialized, listed]

describe('ask server summary', () => {
  test('summarizes every combination of recorded lifecycle events', () => {
    for (let mask = 0; mask < 16; mask += 1) {
      const events = lifecycle.filter((_, index) => mask & (1 << index))
      const summary = summarizeAskServer(events, null)
      expect([summary.expected, summary.started, summary.initialized, summary.listed]).toEqual(
        lifecycle.map((_, index) => (mask & (1 << index) ? 'seen' : 'not_seen')),
      )
    }
  })

  test('distinguishes a missing log and carries a failure line', () => {
    expect(summarizeAskServer(null, 'database setup failed')).toEqual({
      expected: 'not_recorded',
      started: 'not_recorded',
      initialized: 'not_recorded',
      listed: 'not_recorded',
      transport: null,
      command: null,
      registered_tools: null,
      listed_tools: null,
      failure: 'database setup failed',
    })
  })
})
