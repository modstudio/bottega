import { expect, test } from 'bun:test'
import { requestSession, resolveRequestSession, withRequestSession } from './request-session.ts'

test('request metadata wins over a published harness session', () => {
  expect(
    resolveRequestSession({
      meta: { sessionId: ' codex-session ' },
      published: {
        kind: 'published',
        publication: { harness: 'claude-code', session: 'claude-session' },
      },
    }),
  ).toEqual({
    kind: 'session',
    value: { harness: 'codex', session: 'codex-session' },
  })
})

test.each([
  { kind: 'absent' } as const,
  { kind: 'unreadable', path: '/state/broken.json', reason: 'invalid JSON' } as const,
  { kind: 'unavailable', reason: 'no-boot-identity' } as const,
])('request metadata wins when publication lookup is $kind', (published) => {
  expect(resolveRequestSession({ meta: { sessionId: 'codex-session' }, published })).toEqual({
    kind: 'session',
    value: { harness: 'codex', session: 'codex-session' },
  })
})

test('a publication supplies its harness and session when request metadata does not', () => {
  expect(
    resolveRequestSession({
      meta: {},
      published: {
        kind: 'published',
        publication: { harness: 'claude-code', session: 'claude-session' },
      },
    }),
  ).toEqual({
    kind: 'session',
    value: { harness: 'claude-code', session: 'claude-session' },
  })
})

test('a missing request and publication refuses with the clearing remedy', () => {
  expect(resolveRequestSession({ meta: undefined, published: { kind: 'absent' } })).toEqual({
    kind: 'refusal',
    reason:
      'no session id in the request and none published for this harness process; run /clear or start a new session so its SessionStart hook publishes one',
  })
})

test('an unreadable publication refusal names its path, reason, and rewrite remedy', () => {
  expect(
    resolveRequestSession({
      meta: undefined,
      published: { kind: 'unreadable', path: '/state/42-start.json', reason: 'invalid JSON' },
    }),
  ).toEqual({
    kind: 'refusal',
    reason:
      'no session id in the request, and the harness session publication at /state/42-start.json is unreadable (invalid JSON); run /clear so the SessionStart hook rewrites it',
  })
})

test('an unavailable boot identity refusal names the failed observation and restart remedy', () => {
  expect(
    resolveRequestSession({
      meta: undefined,
      published: { kind: 'unavailable', reason: 'no-boot-identity' },
    }),
  ).toEqual({
    kind: 'refusal',
    reason:
      'no session id in the request, and this MCP server could not establish its harness process start time at boot; restart the session so the MCP server restarts with it',
  })
})

test('concurrent scopes keep their request sessions isolated across awaits', async () => {
  const observe = (session: string) =>
    withRequestSession({ harness: 'codex', session }, async () => {
      await Promise.resolve()
      return requestSession()
    })

  expect(await Promise.all([observe('first'), observe('second')])).toEqual([
    { harness: 'codex', session: 'first' },
    { harness: 'codex', session: 'second' },
  ])
})
