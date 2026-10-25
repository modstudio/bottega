import { expect, test } from 'bun:test'
import { addRun } from '../../test/fixtures/store.ts'
import { refreshAgents } from '../agent/agent-registry.ts'
import { db } from '../database/db.ts'
import { pick } from '../route/route.ts'
import { AgentCapacityError } from '../route/routing-refusal.ts'
import {
  agentCapacityWaitMaxMs,
  decideCapacityWait,
  nextCapacityPollMs,
  waitForAgentSelection,
} from './run-agent-capacity.ts'
import { DETACHED_AGENT_CAPACITY_WAIT_MAX_MS, RUN_HOST_WAIT_MAX_MS } from './run-host-capacity.ts'

test('capacity wait decision picks the detached or foreground bound', () => {
  expect(agentCapacityWaitMaxMs(false)).toBe(RUN_HOST_WAIT_MAX_MS)
  expect(agentCapacityWaitMaxMs(true)).toBe(DETACHED_AGENT_CAPACITY_WAIT_MAX_MS)
  expect(decideCapacityWait({ noWait: false, waitedMs: 0, detached: false })).toBe('wait')
  expect(decideCapacityWait({ noWait: true, waitedMs: 0, detached: true })).toBe('refuse')
  expect(
    decideCapacityWait({ noWait: false, waitedMs: RUN_HOST_WAIT_MAX_MS, detached: false }),
  ).toBe('refuse')
  expect(
    decideCapacityWait({
      noWait: false,
      waitedMs: RUN_HOST_WAIT_MAX_MS,
      detached: true,
    }),
  ).toBe('wait')
})

test('capacity poll backoff grows to its cap', () => {
  const schedule = [1_000]
  for (let i = 0; i < 6; i++) schedule.push(nextCapacityPollMs(schedule.at(-1)!))
  expect(schedule).toEqual([1_000, 2_000, 4_000, 8_000, 15_000, 15_000, 15_000])
})

test('selection re-picks only after the cheap running-count fact may have freed a slot', async () => {
  let attempts = 0
  let now = 0
  const waits: string[] = []
  const sleeps: number[] = []
  const facts = [{ codex: 2 }, { codex: 1 }]
  const selected = await waitForAgentSelection({
    select: () => {
      attempts++
      if (attempts < 2) throw new AgentCapacityError('at capacity', { codex: 2 })
      return 'codex'
    },
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms)
      now += ms
    },
    runningCounts: () => facts.shift()!,
    onWait: (at) => waits.push(at),
  })
  expect(selected).toBe('codex')
  expect(attempts).toBe(2)
  expect(sleeps).toEqual([1_000, 2_000])
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
        throw new AgentCapacityError('agent codex is at capacity', { codex: 2 })
      },
      now: () => now,
      sleep: async (ms) => {
        now += ms
      },
      runningCounts: () => ({ codex: 2 }),
    }),
  ).rejects.toThrow('capacity wait bound reached after')
})

test('selection refreshes the running-run snapshot at the wait bound', async () => {
  let now = 0
  let attempts = 0
  await expect(
    waitForAgentSelection({
      select: () => {
        attempts += 1
        throw new AgentCapacityError(
          `agent codex is at capacity (${attempts === 1 ? 'old-run' : 'current-run'})`,
          { codex: 2 },
        )
      },
      now: () => now,
      sleep: async (ms) => {
        now += ms
      },
      runningCounts: () => ({ codex: 2 }),
    }),
  ).rejects.toThrow('current-run')
  expect(attempts).toBe(2)
})
