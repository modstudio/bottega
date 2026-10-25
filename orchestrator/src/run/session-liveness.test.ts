import { describe, expect, test } from 'bun:test'
import { formatSessionLivenessEvidence, sessionLivenessDecision } from './session-liveness.ts'

describe('session liveness decision', () => {
  const old = 700
  const now = 1_000
  const liveWindowMs = 200
  const actorEntry = { pid: 77, startTime: 'shared-start' }
  const facts = {
    ownerSessionId: 'owner',
    ownerSeen: { ancestorChain: '', lastSeenAt: old },
    actorSessionId: 'actor',
    actorAncestorChain: JSON.stringify([actorEntry]),
    now,
    liveWindowMs,
  }

  function decide(
    ownerChain: Array<{ pid: number; startTime: string }>,
    probes: Array<{
      pid: number
      startTime: string
      alive: boolean
      observedStartTime: string | null
    }>,
    lastSeenAt = old,
  ) {
    return sessionLivenessDecision({
      ...facts,
      ownerSeen: { ancestorChain: JSON.stringify(ownerChain), lastSeenAt },
      probes,
    })
  }

  test('a later matching unshared process keeps a session live when its first process is gone', () => {
    const shell = { pid: 42, startTime: 'shell-start' }
    const harness = { pid: 43, startTime: 'harness-start' }
    const evidence = decide(
      [shell, harness, actorEntry, { pid: 1, startTime: 'init' }],
      [
        { ...shell, alive: false, observedStartTime: null },
        { ...harness, alive: true, observedStartTime: 'harness-start' },
      ],
    )

    expect(evidence.ownerProcess).toBe('live')
    expect(evidence.candidates).toHaveLength(2)
    expect(formatSessionLivenessEvidence(evidence)).toBe(
      'pid 42 started shell-start gone; pid 43 started harness-start alive; last_seen 1970-01-01T00:00:00.700Z',
    )
  })

  test('all unshared processes gone is dead only after the live window', () => {
    const first = { pid: 42, startTime: 'first-start' }
    const second = { pid: 43, startTime: 'second-start' }
    const probes = [
      { ...first, alive: false, observedStartTime: null },
      { ...second, alive: false, observedStartTime: null },
    ]

    expect(decide([first, second, actorEntry], probes).ownerProcess).toBe('dead')
    expect(decide([first, second, actorEntry], probes, 900).ownerProcess).toBe('unknown')
  })

  test('pid reuse on every unshared process is dead after the live window', () => {
    const first = { pid: 42, startTime: 'first-start' }
    const second = { pid: 43, startTime: 'second-start' }
    expect(
      decide(
        [first, second],
        [
          { ...first, alive: true, observedStartTime: 'replacement-one' },
          { ...second, alive: true, observedStartTime: 'replacement-two' },
        ],
      ).ownerProcess,
    ).toBe('dead')
  })

  test('an unreadable live process makes the result unknown when the others are gone', () => {
    const first = { pid: 42, startTime: 'first-start' }
    const second = { pid: 43, startTime: 'second-start' }
    expect(
      decide(
        [first, second],
        [
          { ...first, alive: false, observedStartTime: null },
          { ...second, alive: true, observedStartTime: null },
        ],
      ).ownerProcess,
    ).toBe('unknown')
  })

  test('an entirely shared chain is unknown', () => {
    expect(decide([actorEntry, { pid: 1, startTime: 'init' }], []).ownerProcess).toBe('unknown')
  })

  test('absent, empty, malformed owner, and malformed actor chains are unknown', () => {
    expect(sessionLivenessDecision({ ...facts, ownerSeen: null, probes: [] }).ownerProcess).toBe(
      'unknown',
    )
    for (const ancestorChain of [null, '[]', 'not-json'])
      expect(
        sessionLivenessDecision({
          ...facts,
          ownerSeen: { ancestorChain, lastSeenAt: old },
          probes: [],
        }).ownerProcess,
      ).toBe('unknown')
    expect(
      sessionLivenessDecision({
        ...facts,
        ownerSeen: {
          ancestorChain: JSON.stringify([{ pid: 42, startTime: 'owner-start' }]),
          lastSeenAt: old,
        },
        actorAncestorChain: 'not-json',
        probes: [],
      }).ownerProcess,
    ).toBe('unknown')
  })
})
