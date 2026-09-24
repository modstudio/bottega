import { describe, expect, test } from 'bun:test'
import {
  parseServiceIdentity,
  REVISION_CHECK_MS,
  type RevisionMonitorAdapters,
  revisionDecision,
  type ServiceIdentity,
  serviceRevisionStatus,
  startRevisionMonitor,
} from './service-revision.ts'

const identity: ServiceIdentity = {
  holder: 'serve:42',
  pid: 42,
  processStartTime: 'Thu Sep 17 08:00:00 2026',
  revision: 'aaaa',
  revisionError: null,
  currentRevisionError: null,
  startedAt: '2026-09-17T12:00:00.000Z',
}

describe('service revision comparison', () => {
  test('reports current, stale, dead, and reused services', () => {
    expect(
      serviceRevisionStatus(identity, { status: 'live' }, { revision: 'aaaa', error: null }),
    ).toEqual({
      status: 'current',
      revision: 'aaaa',
    })
    expect(
      serviceRevisionStatus(identity, { status: 'live' }, { revision: 'bbbb', error: null }),
    ).toEqual({
      status: 'stale',
      startedRevision: 'aaaa',
      currentRevision: 'bbbb',
      startedAt: identity.startedAt,
    })
    expect(
      serviceRevisionStatus(identity, { status: 'dead' }, { revision: 'bbbb', error: null }),
    ).toEqual({
      status: 'gone',
    })
    expect(
      serviceRevisionStatus(identity, { status: 'reused' }, { revision: 'bbbb', error: null }),
    ).toEqual({
      status: 'gone',
    })
  })

  test('attributes unreadable process identity and revisions', () => {
    expect(
      serviceRevisionStatus(
        identity,
        { status: 'unreadable', reason: 'birth time unavailable' },
        { revision: 'bbbb', error: null },
      ),
    ).toEqual({ status: 'unreadable', side: 'process', reason: 'birth time unavailable' })
    expect(
      serviceRevisionStatus(
        { ...identity, revision: null, revisionError: 'not a checkout' },
        { status: 'live' },
        { revision: 'bbbb', error: null },
      ),
    ).toEqual({ status: 'unreadable', side: 'startup', reason: 'not a checkout' })
    expect(
      serviceRevisionStatus(
        identity,
        { status: 'live' },
        { revision: null, error: 'git unavailable' },
      ),
    ).toEqual({ status: 'unreadable', side: 'current', reason: 'git unavailable' })
  })
})

describe('stored service identity', () => {
  test('reports invalid JSON, a missing field, and a wrong-typed field as unreadable', () => {
    expect(parseServiceIdentity('{')).toMatchObject({
      status: 'unreadable',
      reason: expect.stringContaining('invalid JSON'),
    })

    const missing = { ...identity } as Partial<ServiceIdentity>
    delete missing.holder
    expect(parseServiceIdentity(JSON.stringify(missing))).toEqual({
      status: 'unreadable',
      reason: 'invalid or missing holder',
    })

    expect(parseServiceIdentity(JSON.stringify({ ...identity, pid: '42' }))).toEqual({
      status: 'unreadable',
      reason: 'invalid or missing pid',
    })
  })
})

describe('revision check decision', () => {
  test('checks at most once per minute and restarts only on a readable change', () => {
    expect(revisionDecision('aaaa', { revision: 'bbbb', error: null }, 10, 0)).toBe('wait')
    expect(revisionDecision('aaaa', { revision: 'aaaa', error: null }, REVISION_CHECK_MS, 0)).toBe(
      'continue',
    )
    expect(revisionDecision('aaaa', { revision: 'bbbb', error: null }, REVISION_CHECK_MS, 0)).toBe(
      'restart',
    )
    expect(
      revisionDecision('aaaa', { revision: null, error: 'failed' }, REVISION_CHECK_MS, 0),
    ).toBe('continue')
  })
})

function monitorHarness(
  reads: Array<{ revision: string; error: null } | { revision: null; error: string }>,
) {
  let now = 0
  let callback = () => {}
  const logs: string[] = []
  const exits: number[] = []
  const writes: ServiceIdentity[] = []
  const adapters: RevisionMonitorAdapters = {
    readHead: () => reads.shift()!,
    writeIdentity: (_service, written) => {
      writes.push({ ...written })
    },
    processStartTime: () => identity.processStartTime,
    now: () => now,
    setInterval: (scheduled) => {
      callback = scheduled
      return 1 as unknown as ReturnType<typeof setInterval>
    },
    clearInterval: () => {},
    log: (message) => logs.push(message),
    exit: (code) => exits.push(code),
  }
  return {
    adapters,
    logs,
    exits,
    writes,
    tick: async () => {
      now += REVISION_CHECK_MS
      callback()
      await Bun.sleep(0)
    },
  }
}

describe('revision monitor failures', () => {
  test('logs a failed error-record write and checks again on the next tick', async () => {
    const harness = monitorHarness([
      { revision: 'aaaa', error: null },
      { revision: null, error: 'git unavailable' },
      { revision: 'aaaa', error: null },
    ])
    let attempts = 0
    harness.adapters.writeIdentity = (_service, written) => {
      attempts += 1
      harness.writes.push({ ...written })
      if (attempts === 2) return Promise.reject(new Error('store unavailable'))
    }

    startRevisionMonitor(
      'collect',
      identity.holder,
      () => {},
      () => {},
      harness.adapters,
    )
    await harness.tick()
    await harness.tick()

    expect(attempts).toBe(3)
    expect(harness.logs).toContain('hub: collect identity write failed: store unavailable')
    expect(harness.exits).toEqual([])
  })

  test('releases the lease and exits explicitly when drain rejects', async () => {
    const harness = monitorHarness([
      { revision: 'aaaa', error: null },
      { revision: 'bbbb', error: null },
    ])
    let releases = 0

    startRevisionMonitor(
      'serve',
      identity.holder,
      () => Promise.reject(new Error('drain unavailable')),
      () => {
        releases += 1
      },
      harness.adapters,
    )
    await harness.tick()

    expect(harness.logs).toContain('hub: serve revision changed aaaa -> bbbb; exiting for restart')
    expect(harness.logs).toContain('hub: serve drain failed: drain unavailable')
    expect(releases).toBe(1)
    expect(harness.exits).toEqual([0])
  })
})
