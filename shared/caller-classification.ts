/** Classifies a caller from environment markers without knowing any concern state. */

import type { HarnessName } from './harness-name.ts'
import { requestSession } from './request-session.ts'

export const OPERATOR_SESSION_PREFIX = 'operator:'

export function isOperatorSession(sessionId: string | null): boolean {
  return sessionId?.startsWith(OPERATOR_SESSION_PREFIX) ?? false
}

export type CallerClassification =
  | { kind: 'worker' }
  | { kind: 'harness'; harness: HarnessName; session: string }
  | { kind: 'reserved-operator-session' }
  | { kind: 'unsupported-harness'; markers: string[] }
  | { kind: 'operator' }

export const WORKER_ENVIRONMENT_MARKERS = [
  'BOTTEGA_RUN_ID',
  'BOTTEGA_DEPTH',
  'BOTTEGA_MAIN_CHECKOUT',
  'BOTTEGA_SCRATCH',
  'BOTTEGA_RUN_TOKEN',
  'BOTTEGA_ASK_URL',
] as const

export function isWorkerEnvironment(env: Record<string, string | undefined>): boolean {
  return WORKER_ENVIRONMENT_MARKERS.some((marker) => Boolean(env[marker]?.trim()))
}

function isReservedReaderSession(sessionId: string): boolean {
  return sessionId === 'operator' || sessionId.startsWith('run:') || isOperatorSession(sessionId)
}

const RECOGNIZED_HARNESSES = [
  { environment: 'CLAUDE_CODE_SESSION_ID', harness: 'claude-code' as const },
] as const

const TERMINAL_SESSION_MARKERS = new Set([
  'TERM_SESSION_ID',
  'ITERM_SESSION_ID',
  'XDG_SESSION_ID',
  'SHELL_SESSION_ID',
])

export function classifyCaller(env: Record<string, string | undefined>): CallerClassification {
  if (isWorkerEnvironment(env)) return { kind: 'worker' }
  const scoped = requestSession()
  if (scoped)
    return isReservedReaderSession(scoped.session)
      ? { kind: 'reserved-operator-session' }
      : { kind: 'harness', ...scoped }
  for (const entry of RECOGNIZED_HARNESSES) {
    const session = env[entry.environment]?.trim()
    if (session)
      return isReservedReaderSession(session)
        ? { kind: 'reserved-operator-session' }
        : { kind: 'harness', harness: entry.harness, session }
  }
  const markers = Object.entries(env)
    .filter(
      ([key, value]) =>
        Boolean(value?.trim()) &&
        /(?:SESSION_ID|THREAD_ID)$/.test(key) &&
        !TERMINAL_SESSION_MARKERS.has(key),
    )
    .map(([key]) => key)
    .sort()
  return markers.length ? { kind: 'unsupported-harness', markers } : { kind: 'operator' }
}
