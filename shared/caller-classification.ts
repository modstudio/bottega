/** Classifies a caller from environment markers without knowing any concern state. */
export type CallerClassification =
  | { kind: 'worker' }
  | { kind: 'harness'; harness: 'claude-code'; session: string }
  | { kind: 'reserved-operator-session' }
  | { kind: 'unsupported-harness'; markers: string[] }
  | { kind: 'operator' }

export const WORKER_ENVIRONMENT_MARKERS = [
  'ORCH_RUN_ID',
  'ORCH_DEPTH',
  'ORCH_MAIN_CHECKOUT',
  'ORCH_SCRATCH',
  'ORCH_RUN_TOKEN',
  'ORCH_ASK_URL',
] as const

export const RECOGNIZED_HARNESSES = [
  { environment: 'CLAUDE_CODE_SESSION_ID', harness: 'claude-code' as const },
] as const

const TERMINAL_SESSION_MARKERS = new Set([
  'TERM_SESSION_ID',
  'ITERM_SESSION_ID',
  'XDG_SESSION_ID',
  'SHELL_SESSION_ID',
])

export function classifyCaller(env: Record<string, string | undefined>): CallerClassification {
  if (WORKER_ENVIRONMENT_MARKERS.some((marker) => Boolean(env[marker]?.trim())))
    return { kind: 'worker' }
  for (const entry of RECOGNIZED_HARNESSES) {
    const session = env[entry.environment]?.trim()
    if (session)
      return session.startsWith('operator:')
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
