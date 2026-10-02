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
  const original = [{ session: 'one', project: PLATFORM_SLUG, lastSeen: 900 }]
  expect(resolveAudience(audience, original, 1_000, 200)).toEqual(['one'])
  expect(
    resolveAudience(
      audience,
      [...original, { session: 'late', project: PLATFORM_SLUG, lastSeen: 1_050 }],
      1_100,
      200,
    ),
  ).toEqual(['one', 'late'])
  expect(audienceRefusal(audience, 'architect')).toContain('project:<name>')
})

test('only operator ack-required notices interrupt', () => {
  expect(shouldInterrupt({ authorKind: 'operator', ackRequired: true })).toBe(true)
  expect(shouldInterrupt({ authorKind: 'operator', ackRequired: false })).toBe(false)
  expect(shouldInterrupt({ authorKind: 'architect', ackRequired: true })).toBe(false)
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
      acknowledgedAt: null,
      audienceAtPosting: true,
      now: 21,
    }),
  ).toBe(true)
  expect(
    needsAckEscalation({
      ackRequired: true,
      deadline: 20,
      acknowledgedAt: null,
      audienceAtPosting: false,
      now: 21,
    }),
  ).toBe(false)
})
