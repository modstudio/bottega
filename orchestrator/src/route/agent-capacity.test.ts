import { expect, test } from 'bun:test'
import { AgentCapacityError, decideCapacityWait, waitForAgentSelection } from './agent-capacity.ts'

test('capacity waits unless opted out and refuses at the host wait bound', () => {
  expect(decideCapacityWait({ capacityBlocked: false, noWait: false, waitedMs: 0 })).toBe('select')
  expect(decideCapacityWait({ capacityBlocked: true, noWait: false, waitedMs: 0 })).toBe('wait')
  expect(decideCapacityWait({ capacityBlocked: true, noWait: true, waitedMs: 0 })).toBe('refuse')
  expect(decideCapacityWait({ capacityBlocked: true, noWait: false, waitedMs: 15 * 60_000 })).toBe(
    'refuse',
  )
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
