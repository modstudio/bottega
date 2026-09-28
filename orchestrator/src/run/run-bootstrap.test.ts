import { describe, expect, test } from 'bun:test'
import { abandonedBootstrap, coordinatorSetupDeath, PENDING_BOOTSTRAP_MS } from './run-bootstrap.ts'

describe('abandonedBootstrap', () => {
  const now = Date.parse('2026-09-25T12:00:00Z')
  const old = new Date(now - PENDING_BOOTSTRAP_MS - 1).toISOString()

  test.each([
    ['no pid', { pid: null, pidAlive: false, leaseState: 'missing' as const }],
    ['dead pid', { pid: 42, pidAlive: false, leaseState: 'missing' as const }],
    ['free lease', { pid: 42, pidAlive: true, leaseState: 'free' as const }],
  ])('classifies an old pending row with %s as abandoned', (_label, facts) => {
    expect(abandonedBootstrap({ agent: '(pending)', startedAt: old, now, ...facts })).toBe(true)
  })

  test('leaves a pending row within the launch grace alone', () => {
    expect(
      abandonedBootstrap({
        agent: '(pending)',
        pid: null,
        pidAlive: false,
        leaseState: 'missing',
        startedAt: new Date(now - PENDING_BOOTSTRAP_MS + 1).toISOString(),
        now,
      }),
    ).toBe(false)
  })

  test('never classifies a claimed run as abandoned bootstrap', () => {
    expect(
      abandonedBootstrap({
        agent: 'codex',
        pid: null,
        pidAlive: false,
        leaseState: 'free',
        startedAt: old,
        now,
      }),
    ).toBe(false)
  })
})

describe('coordinatorSetupDeath', () => {
  const deadDuringSetup = {
    agent: 'codex',
    agentPidPresent: false,
    leaseState: 'missing' as const,
    pidAlive: false,
  }

  test.each([
    ['claimed agent before start', deadDuringSetup, true],
    ['pending claim', { ...deadDuringSetup, agent: '(pending)' }, false],
    ['agent started', { ...deadDuringSetup, agentPidPresent: true }, false],
    ['held lease', { ...deadDuringSetup, leaseState: 'held' as const }, false],
    ['live coordinator', { ...deadDuringSetup, pidAlive: true }, false],
  ])('%s => %s', (_label, facts, expected) => {
    expect(coordinatorSetupDeath(facts)).toBe(expected)
  })
})
