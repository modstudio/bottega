// concern: request-session
/** Owns the session identity scoped to one MCP request. */

import { AsyncLocalStorage } from 'node:async_hooks'
import type { HarnessName } from './harness-name.ts'

export type RequestSession = {
  harness: HarnessName
  session: string
}

export type RequestSessionPublication = Pick<RequestSession, 'harness' | 'session'>
export type RequestSessionPublicationLookup =
  | { kind: 'published'; publication: RequestSessionPublication }
  | { kind: 'absent' }
  | { kind: 'unreadable'; path: string; reason: string }
  | { kind: 'unavailable'; reason: 'no-boot-identity' }

export type RequestSessionResolution =
  | { kind: 'session'; value: RequestSession }
  | { kind: 'refusal'; reason: string }

const requestSessionScope = new AsyncLocalStorage<RequestSession>()

const ABSENT_PUBLICATION_REFUSAL =
  'no session id in the request and none published for this harness process; run /clear or start a new session so its SessionStart hook publishes one'
const NO_BOOT_IDENTITY_REFUSAL =
  'no session id in the request, and this MCP server could not establish its harness process start time at boot; restart the session so the MCP server restarts with it'

/** Resolve the request-carried session before the machine-local publication fallback. */
export function resolveRequestSession(input: {
  meta: Record<string, unknown> | null | undefined
  published: RequestSessionPublicationLookup
}): RequestSessionResolution {
  const session = input.meta?.sessionId
  if (typeof session === 'string' && session.trim())
    return { kind: 'session', value: { harness: 'codex', session: session.trim() } }
  if (input.published.kind === 'published')
    return { kind: 'session', value: input.published.publication }
  if (input.published.kind === 'absent')
    return { kind: 'refusal', reason: ABSENT_PUBLICATION_REFUSAL }
  if (input.published.kind === 'unreadable')
    return {
      kind: 'refusal',
      reason: `no session id in the request, and the harness session publication at ${input.published.path} is unreadable (${input.published.reason}); run /clear so the SessionStart hook rewrites it`,
    }
  return { kind: 'refusal', reason: NO_BOOT_IDENTITY_REFUSAL }
}

export function requestSession(): RequestSession | undefined {
  return requestSessionScope.getStore()
}

export function withRequestSession<T>(value: RequestSession, work: () => T): T {
  return requestSessionScope.run(value, work)
}
