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
  runAudienceRefusal,
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
  const original = [
    {
      reader: 'one',
      role: 'architect' as const,
      project: PLATFORM_SLUG,
      machine: 'host-a',
      lastSeen: 900,
    },
  ]
  expect(resolveAudience(audience, original, 1_000, 200)).toEqual(['one'])
  expect(
    resolveAudience(
      audience,
      [
        ...original,
        {
          reader: 'late',
          role: 'architect',
          project: PLATFORM_SLUG,
          machine: 'host-b',
          lastSeen: 1_050,
        },
      ],
      1_100,
      200,
    ),
  ).toEqual(['one', 'late'])
  expect(audienceRefusal(audience, 'architect')).toContain('project:<name>')
})

test('machine audiences resolve by live presence', () => {
  const presence = [
    {
      reader: 'same',
      role: 'architect' as const,
      project: PLATFORM_SLUG,
      machine: 'host-a',
      lastSeen: 900,
    },
    {
      reader: 'other',
      role: 'architect' as const,
      project: PLATFORM_SLUG,
      machine: 'host-b',
      lastSeen: 900,
    },
  ]
  expect(resolveAudience(parseAudience('machine:host-a'), presence, 1_000, 200)).toEqual(['same'])
  expect(parseAudience('machine:this')).toEqual({ kind: 'machine', value: 'this' })
})

test('worker audiences resolve projects, runs, and machines without leaking session audiences', () => {
  const facts = [
    {
      reader: 'architect',
      role: 'architect' as const,
      project: PLATFORM_SLUG,
      machine: 'host-a',
      lastSeen: 900,
    },
    {
      reader: 'run:10',
      role: 'worker' as const,
      project: PLATFORM_SLUG,
      machine: 'host-a',
      live: true,
      runIds: new Set([10, 11]),
    },
  ]
  expect(resolveAudience(parseAudience(`project:${PLATFORM_SLUG}`), facts, 1_000, 200)).toEqual([
    'architect',
    'run:10',
  ])
  expect(resolveAudience(parseAudience(`workers:${PLATFORM_SLUG}`), facts, 1_000, 200)).toEqual([
    'run:10',
  ])
  expect(resolveAudience(parseAudience('run:11'), facts, 1_000, 200)).toEqual(['run:10'])
  expect(resolveAudience(parseAudience('machine:host-a'), facts, 1_000, 200)).toEqual([
    'architect',
    'run:10',
  ])
  expect(resolveAudience(parseAudience('operator'), facts, 1_000, 200)).toEqual(['operator'])
  expect(resolveAudience(parseAudience('architects'), facts, 1_000, 200)).toEqual(['architect'])
  expect(resolveAudience(parseAudience('session:architect'), facts, 1_000, 200)).toEqual([
    'architect',
  ])
  expect(() => parseAudience('session:run:10')).toThrow(/reserved/)
})

test('unsupported audience refusal lists every accepted form', () => {
  expect(() => parseAudience('everyone')).toThrow(
    'unsupported board audience everyone; use operator, architects, project:<name>, task:<KEY>, workers:<project>, run:<id>, machine:<name>, or session:<id>',
  )
})

test('run audience policy permits the owner and operator but identifies a foreign owner', () => {
  const audience = parseAudience('run:42')
  expect(runAudienceRefusal(audience, 'architect', 'owner', 'owner')).toBeNull()
  expect(runAudienceRefusal(audience, 'operator', null, 'owner')).toBeNull()
  expect(runAudienceRefusal(audience, 'architect', 'foreign', 'owner')).toBe(
    'run 42 is owned by session owner; address project:<name> or workers:<project>, or ask the owner',
  )
  expect(runAudienceRefusal(audience, 'architect', 'foreign', null)).toContain(
    'run 42 has no owning session',
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
  expect(
    shouldInterrupt({
      authorKind: 'architect',
      audienceKind: 'session',
      ackRequired: false,
      claimConflict: true,
    }),
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
