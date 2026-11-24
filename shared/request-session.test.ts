import { expect, test } from 'bun:test'
import { requestSession, resolveRequestSession, withRequestSession } from './request-session.ts'

test('request metadata wins over a published harness session', () => {
  expect(
    resolveRequestSession({ meta: { sessionId: ' codex-session ' }, published: 'claude-session' }),
  ).toEqual({
    kind: 'session',
    value: { harness: 'codex', session: 'codex-session' },
  })
})

test('a publication supplies the session when request metadata does not', () => {
  expect(resolveRequestSession({ meta: {}, published: 'claude-session' })).toEqual({
    kind: 'session',
    value: { harness: 'claude-code', session: 'claude-session' },
  })
})

test('a missing request and publication refuses with the clearing remedy', () => {
  expect(resolveRequestSession({ meta: undefined, published: null })).toEqual({
    kind: 'refusal',
    reason:
      'no session id in the request and none published for this harness process; run /clear or start a new session so its SessionStart hook publishes one',
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
