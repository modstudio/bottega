import { expect, test } from 'bun:test'
import { providerErrorStreakCooling, type RecentTerminalRun } from './routing-cooldown.ts'

const row = (overrides: Partial<RecentTerminalRun> = {}): RecentTerminalRun => ({
  agent: 'a',
  status: 'failed',
  failure_kind: 'provider_error',
  mins_ago: 1,
  ...overrides,
})

test('three consecutive provider errors cool the agent', () => {
  expect(providerErrorStreakCooling([row(), row(), row()])).toMatchObject({
    agent: 'a',
    failure_kind: 'provider_error',
  })
})

test('two provider errors followed by a success do not cool the agent', () => {
  expect(
    providerErrorStreakCooling([
      row(),
      row(),
      row({ status: 'ok', failure_kind: null, mins_ago: 3 }),
    ]),
  ).toBeNull()
})
