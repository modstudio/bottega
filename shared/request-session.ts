// concern: request-session
/** Owns the session identity scoped to one MCP request. */

import { AsyncLocalStorage } from 'node:async_hooks'

export type RequestSession = {
  harness: 'claude-code' | 'codex'
  session: string
}

export type RequestSessionResolution =
  | { kind: 'session'; value: RequestSession }
  | { kind: 'refusal'; reason: string }

const requestSessionScope = new AsyncLocalStorage<RequestSession>()

const REQUEST_SESSION_REFUSAL =
  'no session id in the request and none published for this harness process; run /clear or start a new session so its SessionStart hook publishes one'

/** Resolve the request-carried session before the machine-local publication fallback. */
export function resolveRequestSession(input: {
  meta: Record<string, unknown> | null | undefined
  published: string | null
}): RequestSessionResolution {
  const session = input.meta?.sessionId
  if (typeof session === 'string' && session.trim())
    return { kind: 'session', value: { harness: 'codex', session: session.trim() } }
  if (input.published)
    return {
      kind: 'session',
      value: { harness: 'claude-code', session: input.published },
    }
  return { kind: 'refusal', reason: REQUEST_SESSION_REFUSAL }
}

export function requestSession(): RequestSession | undefined {
  return requestSessionScope.getStore()
}

export function withRequestSession<T>(value: RequestSession, work: () => T): T {
  return requestSessionScope.run(value, work)
}
