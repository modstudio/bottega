import { expect, test } from 'bun:test'
import { addRun } from '../../test/fixtures/store.ts'
import { refreshAgents } from '../agent/agent-registry.ts'
import { db } from '../database/db.ts'
import { pick } from '../route/route.ts'
import { AgentCapacityError } from '../route/routing-refusal.ts'
import { decideCapacityWait, waitForAgentSelection } from './run-agent-capacity.ts'

test('capacity waits unless opted out and refuses at the host wait bound', () => {
  expect(decideCapacityWait({ noWait: false, waitedMs: 0 })).toBe('wait')
  expect(decideCapacityWait({ noWait: true, waitedMs: 0 })).toBe('refuse')
  expect(decideCapacityWait({ noWait: false, waitedMs: 15 * 60_000 })).toBe('refuse')
})

test('selection polls capacity and announces the wait once', async () => {
  let attempts = 0
  let now = 0
  const waits: string[] = []
  const selected = await waitForAgentSelection({
    select: () => {
      attempts++
      if (attempts < 3) throw new AgentCapacityError('at capacity')
      return 'codex'
    },
    now: () => now,
    sleep: async (ms) => {
      now += ms
    },
    onWait: (at) => waits.push(at),
  })
  expect(selected).toBe('codex')
  expect(attempts).toBe(3)
  expect(waits).toHaveLength(1)
})

test('a named agent at its cap produces the capacity signal used by admission', () => {
  const cap = 2
  db().query("UPDATE agent SET max_concurrent=? WHERE name='codex'").run(cap)
  refreshAgents()
  for (let i = 0; i < cap; i++) addRun({ agent: 'codex', job: 'craft', status: 'running' })

  expect(() => pick('craft', 'codex')).toThrow(AgentCapacityError)
  expect(() => pick('craft', 'codex')).toThrow(`agent codex is at capacity (${cap} running:`)
})

test('selection names the exhausted wait bound in its refusal', async () => {
  let now = 0
  await expect(
    waitForAgentSelection({
      select: () => {
        throw new AgentCapacityError('agent codex is at capacity')
      },
      now: () => now,
      sleep: async (ms) => {
        now += ms
      },
    }),
  ).rejects.toThrow('capacity wait bound reached after')
})
