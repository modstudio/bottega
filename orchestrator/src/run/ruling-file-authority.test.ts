import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { decideCanonFiling, effectiveRuling, fileRulingDecision } from './ruling-file-authority.ts'

const decide = (overrides: Partial<Parameters<typeof fileRulingDecision>[0]> = {}) =>
  fileRulingDecision({
    answeredAt: '2026-09-20T12:00:00.000Z',
    overturnedAt: null,
    replacement: null,
    filedAs: null,
    requested: 'doc',
    owner: 'owner-session',
    actor: 'owner-session',
    ownerLastSeenAt: 900,
    chainLastActivityAt: 800,
    now: 1_000,
    windowMs: 200,
    fromOperator: false,
    channel: 'cli',
    sessionIdPresent: true,
    depthPresent: false,
    dashboardAuthorized: false,
    runProject: PLATFORM_SLUG,
    ...overrides,
  })

describe('file ruling decision', () => {
  test('allows an answered ruling that has not been filed', () => {
    expect(decide()).toEqual({ kind: 'allow', operator: false })
    expect(decide({ requested: 'canon-proposal' })).toEqual({ kind: 'allow', operator: false })
  })

  test('refuses an unanswered question', () => {
    expect(decide({ answeredAt: null })).toEqual({ kind: 'refuse', code: 'unanswered' })
  })

  test('refuses an overturned ruling without a replacement', () => {
    expect(decide({ overturnedAt: '2026-09-21T12:00:00.000Z', replacement: null })).toEqual({
      kind: 'refuse',
      code: 'overturned-without-replacement',
    })
  })

  test('allows an overturned ruling with a replacement', () => {
    expect(
      decide({
        overturnedAt: '2026-09-21T12:00:00.000Z',
        replacement: 'Use the replacement.',
      }),
    ).toEqual({ kind: 'allow', operator: false })
  })

  test('refuses a second filing of the same kind', () => {
    expect(decide({ filedAs: 'doc' })).toEqual({ kind: 'refuse', code: 'already-filed' })
    expect(decide({ filedAs: 'canon-proposal', requested: 'canon-proposal' })).toEqual({
      kind: 'refuse',
      code: 'already-filed',
    })
  })

  test('refuses a second filing of the other kind because one question holds one filing', () => {
    expect(decide({ filedAs: 'doc', requested: 'canon-proposal' })).toEqual({
      kind: 'refuse',
      code: 'already-filed',
    })
  })

  test('refuses writing canon rows through --as doc', () => {
    expect(decide({ scope: 'canon' })).toEqual({ kind: 'refuse', code: 'canon-direct' })
    expect(decideCanonFiling('doc', 'canon')).toBe('canon is never written directly')
    expect(decideCanonFiling('doc', 'project')).toBeNull()
    expect(decideCanonFiling('canon-proposal', 'canon')).toBeNull()
  })

  test('refuses a session other than the chain owner', () => {
    expect(decide({ actor: 'other-session' })).toEqual({
      kind: 'refuse',
      code: 'owner-mismatch',
      owner: 'owner-session',
      actor: 'other-session',
    })
  })

  test('allows the hub operator path with the dashboard capability', () => {
    expect(
      decide({
        actor: null,
        channel: 'ui',
        fromOperator: true,
        sessionIdPresent: false,
        depthPresent: false,
        dashboardAuthorized: true,
      }),
    ).toEqual({ kind: 'allow', operator: true })
  })

  test('refuses the ui channel without the dashboard capability', () => {
    expect(
      decide({
        channel: 'ui',
        fromOperator: true,
        sessionIdPresent: false,
        depthPresent: false,
        dashboardAuthorized: false,
      }),
    ).toEqual({ kind: 'refuse', code: 'dashboard-capability' })
  })

  test('refuses the ui channel when a session marker is set', () => {
    expect(
      decide({
        channel: 'ui',
        fromOperator: true,
        sessionIdPresent: true,
        depthPresent: false,
        dashboardAuthorized: true,
      }),
    ).toEqual({
      kind: 'refuse',
      code: 'session-marker',
      actor: 'CLAUDE_CODE_SESSION_ID',
    })
  })

  test('refuses a scope or subject that names another project on the owner path', () => {
    expect(decide({ subject: 'other-project' })).toEqual({
      kind: 'refuse',
      code: 'foreign-project',
    })
    expect(decide({ scope: 'machine' })).toEqual({ kind: 'refuse', code: 'foreign-project' })
  })

  test('allows a matching resume project subject on the owner path', () => {
    expect(decide({ scope: 'resume', subject: PLATFORM_SLUG })).toEqual({
      kind: 'allow',
      operator: false,
    })
  })

  test('allows another project address on the operator path', () => {
    expect(decide({ fromOperator: true, subject: 'other-project' })).toEqual({
      kind: 'allow',
      operator: true,
    })
  })
})

describe('effective ruling', () => {
  test('uses the replacement on an overturned question', () => {
    expect(
      effectiveRuling({
        answer: 'Old',
        overturnedAt: '2026-09-21T12:00:00.000Z',
        replacement: 'New',
      }),
    ).toBe('New')
  })

  test('uses the answer when the ruling stands', () => {
    expect(effectiveRuling({ answer: 'Standing', overturnedAt: null, replacement: null })).toBe(
      'Standing',
    )
  })
})
