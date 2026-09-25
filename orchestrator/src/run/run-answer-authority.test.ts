import { describe, expect, test } from 'bun:test'
import { answerAuthorityDecision } from './run-answer-authority.ts'

const decide = (overrides: Partial<Parameters<typeof answerAuthorityDecision>[0]> = {}) =>
  answerAuthorityDecision({
    channel: 'cli',
    fromOperator: false,
    sessionIdPresent: true,
    depthPresent: true,
    dashboardAuthorized: false,
    owner: 'owner-session',
    actor: 'owner-session',
    ...overrides,
  })

describe('answer authority decision', () => {
  test('keeps ordinary CLI owner behavior', () => {
    expect(decide()).toEqual({ kind: 'allow-as-owner' })
    expect(decide({ actor: 'other-session' })).toEqual({
      kind: 'refuse',
      code: 'owner-mismatch',
      owner: 'owner-session',
      actor: 'other-session',
    })
  })

  test('requires operator attribution for UI answers', () => {
    expect(
      decide({
        channel: 'ui',
        fromOperator: false,
        sessionIdPresent: false,
        depthPresent: false,
      }),
    ).toEqual({ kind: 'refuse', code: 'operator-attribution' })
  })

  test('requires the dashboard capability for UI answers', () => {
    expect(
      decide({
        channel: 'ui',
        fromOperator: true,
        dashboardAuthorized: false,
        sessionIdPresent: false,
        depthPresent: false,
      }),
    ).toEqual({ kind: 'refuse', code: 'dashboard-capability' })
  })

  test('refuses UI authority from either agent-session marker', () => {
    expect(
      decide({
        channel: 'ui',
        fromOperator: true,
        dashboardAuthorized: true,
        sessionIdPresent: true,
        depthPresent: false,
      }),
    ).toEqual({
      kind: 'refuse',
      code: 'session-marker',
      actor: 'CLAUDE_CODE_SESSION_ID',
    })
    expect(
      decide({
        channel: 'ui',
        fromOperator: true,
        dashboardAuthorized: true,
        sessionIdPresent: false,
        depthPresent: true,
      }),
    ).toEqual({ kind: 'refuse', code: 'session-marker', actor: 'ORCH_DEPTH' })
  })

  test('grants the external UI operator without adopting the owner identity', () => {
    expect(
      decide({
        channel: 'ui',
        fromOperator: true,
        dashboardAuthorized: true,
        sessionIdPresent: false,
        depthPresent: false,
        actor: null,
      }),
    ).toEqual({ kind: 'allow-as-operator', actor: 'operator:ui' })
  })
})
