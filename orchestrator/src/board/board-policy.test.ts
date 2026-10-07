import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  acknowledgementRefusal,
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
  validatePostNoticeInput,
} from './board-policy.ts'
import { boardActor } from './board-store.ts'

test('notice header fields refuse every line separator', () => {
  expect(() => validatePostNoticeInput({ title: 'bad\nvalue', body: 'body' })).toThrow(
    /title contains a line break/,
  )
  expect(() => validatePostNoticeInput({ title: 'safe', body: 'body', task: 'DEV\r9' })).toThrow(
    /task tag contains a line break/,
  )
  expect(() =>
    validatePostNoticeInput({ title: 'safe', body: 'body', paths: ['src\u2028file'] }),
  ).toThrow(/path tag contains a line break/)
  expect(() =>
    validatePostNoticeInput({ title: 'safe', body: 'body', topics: ['gate\u2029forged'] }),
  ).toThrow(/topic contains a line break/)
})

test('architect identity is a table with only the ruled Claude entry', () => {
  expect(architectIdentity({ CLAUDE_CODE_SESSION_ID: 'claude-1' })).toEqual({
    session: 'claude-1',
    harness: 'claude-code',
  })
  expect(architectIdentity({ CODEX_THREAD_ID: 'codex-1' })).toBeNull()
})

test('an unsupported board caller refusal names its triggering markers', () => {
  expect(() => boardActor({ CODEX_THREAD_ID: 'codex-1', OTHER_SESSION_ID: 'session-1' })).toThrow(
    '(CODEX_THREAD_ID, OTHER_SESSION_ID)',
  )
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

test('task-only facts contribute only to task audiences and every audience is distinct', () => {
  const facts = [
    {
      reader: 'holder',
      role: 'architect' as const,
      project: PLATFORM_SLUG,
      machine: 'host-a',
      lastSeen: 900,
      taskKeys: new Set(['DEV-9']),
    },
    {
      reader: 'holder',
      role: 'architect' as const,
      project: '',
      machine: 'host-a',
      live: true,
      taskKeys: new Set(['DEV-9']),
      taskAudienceOnly: true,
    },
    {
      reader: 'stale-holder',
      role: 'architect' as const,
      project: '',
      machine: 'host-a',
      live: true,
      taskKeys: new Set(['DEV-9']),
      taskAudienceOnly: true,
    },
  ]
  expect(resolveAudience(parseAudience('task:DEV-9'), facts, 1_000, 200)).toEqual([
    'holder',
    'stale-holder',
  ])
  expect(resolveAudience(parseAudience('architects'), facts, 1_000, 200)).toEqual(['holder'])
  expect(resolveAudience(parseAudience('machine:host-a'), facts, 1_000, 200)).toEqual(['holder'])
  expect(resolveAudience(parseAudience('session:stale-holder'), facts, 1_000, 200)).toEqual([])
})

test('unsupported audience refusal lists every accepted form', () => {
  expect(() => parseAudience('everyone')).toThrow(
    'unsupported board audience everyone; use operator, architects, project:<name>, task:<KEY>, workers:<project>, run:<id>, machine:<name>, or session:<id>',
  )
})

test('run audience accepts a positive integer or a uuid and refuses other values', () => {
  expect(parseAudience('run:42')).toEqual({ kind: 'run', value: 42 })
  expect(parseAudience('run:01990000-0000-7000-8000-0000000000aa')).toEqual({
    kind: 'run',
    value: '01990000-0000-7000-8000-0000000000aa',
  })
  expect(() => parseAudience('run:0')).toThrow(/positive id/)
  expect(() => parseAudience('run:not-a-run')).toThrow(/positive id/)
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

test('every addressed ack-required notice interrupts except the reader own post and a foreign operator', () => {
  expect(
    shouldInterrupt({ authorKind: 'operator', audienceKind: 'architects', ackRequired: true }),
  ).toBe(true)
  expect(
    shouldInterrupt({ authorKind: 'operator', audienceKind: 'architects', ackRequired: false }),
  ).toBe(false)
  expect(
    shouldInterrupt({ authorKind: 'architect', audienceKind: 'project', ackRequired: true }),
  ).toBe(true)
  expect(
    shouldInterrupt({ authorKind: 'architect', audienceKind: 'machine', ackRequired: true }),
  ).toBe(true)
  expect(
    shouldInterrupt({
      authorKind: 'architect',
      audienceKind: 'project',
      ackRequired: true,
      ownPost: true,
    }),
  ).toBe(false)
  expect(
    shouldInterrupt({
      authorKind: 'operator',
      authorIsSignedInUser: false,
      audienceKind: 'project',
      ackRequired: true,
    }),
  ).toBe(false)
  expect(
    shouldInterrupt({
      authorKind: 'architect',
      audienceKind: 'session',
      ackRequired: false,
      claimConflict: true,
    }),
  ).toBe(true)
})

test('acknowledgement authority is operator-wide and architect-project-local', () => {
  for (const expression of ['operator', 'architects', 'task:DEV-1', 'machine:host']) {
    expect(
      acknowledgementRefusal({
        ackRequired: true,
        audience: parseAudience(expression),
        authorKind: 'operator',
        authorProject: null,
      }),
    ).toBeNull()
  }
  expect(
    acknowledgementRefusal({
      ackRequired: true,
      audience: parseAudience(`project:${PLATFORM_SLUG}`),
      authorKind: 'architect',
      authorProject: PLATFORM_SLUG,
    }),
  ).toBeNull()
  for (const expression of ['project:other', 'architects', 'task:DEV-1', 'machine:host']) {
    expect(
      acknowledgementRefusal({
        ackRequired: true,
        audience: parseAudience(expression),
        authorKind: 'architect',
        authorProject: PLATFORM_SLUG,
      }),
    ).toContain('project:<your project>')
  }
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
