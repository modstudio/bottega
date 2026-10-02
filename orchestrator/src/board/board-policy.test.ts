import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  architectIdentity,
  audienceRefusal,
  BOARD_POST_RATE_LIMIT,
  messageCanBeReaped,
  messageIsLive,
  needsAckEscalation,
  parseAudience,
  postDecision,
  resolveAudience,
  shouldInterrupt,
} from './board-policy.ts'

test('architect identity is a table with only the ruled Claude entry', () => {
  expect(architectIdentity({ CLAUDE_CODE_SESSION_ID: 'claude-1' })).toEqual({
    session: 'claude-1',
    harness: 'claude-code',
  })
  expect(architectIdentity({ CODEX_THREAD_ID: 'codex-1' })).toBeNull()
})

test('audiences resolve at delivery, including a late joiner', () => {
  const audience = parseAudience('architects')
  const original = [{ session: 'one', project: PLATFORM_SLUG, machine: 'host-a', lastSeen: 900 }]
  expect(resolveAudience(audience, original, 1_000, 200)).toEqual(['one'])
  expect(
    resolveAudience(
      audience,
      [
        ...original,
        { session: 'late', project: PLATFORM_SLUG, machine: 'host-b', lastSeen: 1_050 },
      ],
      1_100,
      200,
    ),
  ).toEqual(['one', 'late'])
  expect(audienceRefusal(audience, 'architect')).toContain('project:<name>')
})

test('machine audiences resolve by live presence', () => {
  const presence = [
    { session: 'same', project: PLATFORM_SLUG, machine: 'host-a', lastSeen: 900 },
    { session: 'other', project: PLATFORM_SLUG, machine: 'host-b', lastSeen: 900 },
  ]
  expect(resolveAudience(parseAudience('machine:host-a'), presence, 1_000, 200)).toEqual(['same'])
  expect(parseAudience('machine:this')).toEqual({ kind: 'machine', value: 'this' })
})

test('unsupported audience refusal lists every accepted form', () => {
  expect(() => parseAudience('everyone')).toThrow(
    'unsupported board audience everyone; use operator, architects, project:<name>, machine:<name>, or session:<id>',
  )
})

test('operator and machine ack-required notices interrupt', () => {
  expect(
    shouldInterrupt({ authorKind: 'operator', audienceKind: 'architects', ackRequired: true }),
  ).toBe(true)
  expect(
    shouldInterrupt({ authorKind: 'operator', audienceKind: 'architects', ackRequired: false }),
  ).toBe(false)
  expect(
    shouldInterrupt({ authorKind: 'architect', audienceKind: 'project', ackRequired: true }),
  ).toBe(false)
  expect(
    shouldInterrupt({ authorKind: 'architect', audienceKind: 'machine', ackRequired: true }),
  ).toBe(true)
})

test('expiry, withdrawal, and retention are separate decisions', () => {
  expect(messageIsLive({ expiresAt: 20, withdrawnAt: null }, 10)).toBe(true)
  expect(messageIsLive({ expiresAt: 20, withdrawnAt: 9 }, 10)).toBe(false)
  expect(messageCanBeReaped({ expiresAt: 0, withdrawnAt: null }, 1)).toBe(false)
})

test('duplicate drop precedes the author rate cap', () => {
  expect(postDecision({ recentPosts: BOARD_POST_RATE_LIMIT, duplicate: true })).toBe(
    'drop-duplicate',
  )
  expect(postDecision({ recentPosts: BOARD_POST_RATE_LIMIT, duplicate: false })).toBe(
    'rate-limited',
  )
})

test('overdue unacknowledged posting-time audience member escalates', () => {
  expect(
    needsAckEscalation({
      ackRequired: true,
      deadline: 20,
      expiresAt: 30,
      withdrawnAt: null,
      acknowledgedAt: null,
      audienceAtPosting: true,
      now: 21,
    }),
  ).toBe(true)
  expect(
    needsAckEscalation({
      ackRequired: true,
      deadline: 20,
      expiresAt: 30,
      withdrawnAt: null,
      acknowledgedAt: null,
      audienceAtPosting: false,
      now: 21,
    }),
  ).toBe(false)
  expect(
    needsAckEscalation({
      ackRequired: true,
      deadline: 20,
      expiresAt: 21,
      withdrawnAt: null,
      acknowledgedAt: null,
      audienceAtPosting: true,
      now: 21,
    }),
  ).toBe(false)
})
