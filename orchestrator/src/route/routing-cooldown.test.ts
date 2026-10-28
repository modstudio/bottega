import { expect, test } from 'bun:test'
import { providerErrorStreakCooling, type RecentTerminalRun } from './routing-cooldown.ts'

const row = (overrides: Partial<RecentTerminalRun> = {}): RecentTerminalRun => {
  const minsAgo = overrides.mins_ago ?? 1
  return {
    record_id: crypto.randomUUID(),
    number: 1,
    agent: 'a',
    job: 'craft',
    status: 'failed',
    failure_kind: 'provider_error',
    endpoint_key_source: null,
    finished_at: Date.now() - minsAgo * 60_000,
    mins_ago: minsAgo,
    ...overrides,
  }
}

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

test('a successful probe clears the provider-error streak', () => {
  expect(
    providerErrorStreakCooling([
      row(),
      row(),
      row({ job: 'agent-probe', status: 'ok', failure_kind: null }),
    ]),
  ).toBeNull()
})
