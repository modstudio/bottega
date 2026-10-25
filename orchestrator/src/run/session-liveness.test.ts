import { describe, expect, test } from 'bun:test'
import { sessionLivenessDecision } from './session-liveness.ts'

describe('session liveness decision', () => {
  const old = 700
  const now = 1_000
  const liveWindowMs = 200
  const owner = JSON.stringify([
    { pid: 1, startTime: 'init' },
    { pid: 42, startTime: 'owner-start' },
  ])
  const facts = {
    ownerSessionId: 'owner',
    ownerSeen: { ancestorChain: owner, lastSeenAt: old },
    actorSessionId: 'actor',
    actorAncestorChain: JSON.stringify([{ pid: 77, startTime: 'actor-start' }]),
    now,
    liveWindowMs,
  }

  test('dead needs a gone anchor and an old last_seen', () => {
    expect(sessionLivenessDecision({ ...facts, probe: { alive: false, startTime: null } })).toEqual(
      {
        ownerProcess: 'dead',
        anchor: { pid: 42, startTime: 'owner-start' },
        ownerLastSeenAt: old,
      },
    )
    expect(
      sessionLivenessDecision({
        ...facts,
        ownerSeen: { ancestorChain: owner, lastSeenAt: 900 },
        probe: { alive: false, startTime: null },
      }).ownerProcess,
    ).toBe('unknown')
  })

  test('pid reuse is dead only after the live window', () => {
    expect(
      sessionLivenessDecision({
        ...facts,
        probe: { alive: true, startTime: 'replacement-start' },
      }).ownerProcess,
    ).toBe('dead')
  })

  test('matching process is live and an unreadable live process is unknown', () => {
    expect(
      sessionLivenessDecision({
        ...facts,
        probe: { alive: true, startTime: 'owner-start' },
      }).ownerProcess,
    ).toBe('live')
    expect(
      sessionLivenessDecision({ ...facts, probe: { alive: true, startTime: null } }).ownerProcess,
    ).toBe('unknown')
  })

  test('a shared anchor is unknown', () => {
    expect(
      sessionLivenessDecision({
        ...facts,
        actorAncestorChain: JSON.stringify([{ pid: 42, startTime: 'owner-start' }]),
        probe: { alive: false, startTime: null },
      }).ownerProcess,
    ).toBe('unknown')
  })

  test('absent, empty, and malformed chains are unknown', () => {
    expect(sessionLivenessDecision({ ...facts, ownerSeen: null, probe: null }).ownerProcess).toBe(
      'unknown',
    )
    for (const ancestorChain of [null, '[]', 'not-json'])
      expect(
        sessionLivenessDecision({
          ...facts,
          ownerSeen: { ancestorChain, lastSeenAt: old },
          probe: null,
        }).ownerProcess,
      ).toBe('unknown')
  })

  test('pid 1 is skipped when choosing the anchor', () => {
    expect(
      sessionLivenessDecision({ ...facts, probe: { alive: false, startTime: null } }).anchor,
    ).toEqual({ pid: 42, startTime: 'owner-start' })
  })
})
