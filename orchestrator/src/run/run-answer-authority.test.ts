import { describe, expect, test } from 'bun:test'
import { answerAuthorityDecision } from './run-answer-authority.ts'

const decide = (overrides: Partial<Parameters<typeof answerAuthorityDecision>[0]> = {}) =>
  answerAuthorityDecision({
    channel: 'cli',
    fromOperator: false,
    sessionIdPresent: true,
    depthPresent: true,
    owner: 'owner-session',
    actor: 'owner-session',
    ...overrides,
  })

describe('answer authority decision', () => {
  test('keeps ordinary CLI owner behavior', () => {
    expect(decide()).toEqual({ kind: 'allow-as-owner' })
    expect(decide({ actor: 'other-session' })).toEqual({
      kind: 'refuse',
      reason:
        'run is owned by session owner-session; current session other-session cannot answer it',
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
    ).toEqual({ kind: 'refuse', reason: '--channel ui requires --from-operator' })
  })

  test('refuses UI authority from either agent-session marker', () => {
    expect(
      decide({ channel: 'ui', fromOperator: true, sessionIdPresent: true, depthPresent: false }),
    ).toEqual({
      kind: 'refuse',
      reason: '--channel ui is refused when CLAUDE_CODE_SESSION_ID is set',
    })
    expect(
      decide({ channel: 'ui', fromOperator: true, sessionIdPresent: false, depthPresent: true }),
    ).toEqual({ kind: 'refuse', reason: '--channel ui is refused when ORCH_DEPTH is set' })
  })

  test('grants the external UI operator without adopting the owner identity', () => {
    expect(
      decide({
        channel: 'ui',
        fromOperator: true,
        sessionIdPresent: false,
        depthPresent: false,
        actor: null,
      }),
    ).toEqual({ kind: 'allow-as-operator', actor: 'operator:ui' })
  })
})
