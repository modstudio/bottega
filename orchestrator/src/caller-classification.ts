// concern: caller-classification
/** Classifies a caller from environment markers. Must not know databases, runs, or commands. */

export type CallerClassification =
  | { kind: 'worker' }
  | { kind: 'harness'; harness: 'claude-code'; session: string }
  | { kind: 'reserved-operator-session' }
  | { kind: 'unsupported-harness'; markers: string[] }
  | { kind: 'operator' }

export type CallerIdentityResolution =
  | { kind: 'identity'; session: string }
  | { kind: 'no-identity'; reason: 'worker' }
  | { kind: 'no-identity'; reason: 'unsupported-harness'; markers: string[] }
  | { kind: 'no-identity'; reason: 'reserved-operator-prefix' }
  | { kind: 'no-identity'; reason: 'operator-machine-id-missing' }

/** Values set specifically on every relevant worker launch shape. */
export const WORKER_ENVIRONMENT_MARKERS = [
  'ORCH_RUN_ID',
  'ORCH_DEPTH',
  'ORCH_MAIN_CHECKOUT',
  'ORCH_SCRATCH',
  'ORCH_RUN_TOKEN',
  'ORCH_ASK_URL',
] as const

const RECOGNIZED_HARNESSES = [
  { environment: 'CLAUDE_CODE_SESSION_ID', harness: 'claude-code' as const },
] as const

const TERMINAL_SESSION_MARKERS = new Set([
  'TERM_SESSION_ID', // Apple Terminal and iTerm identify a terminal window, not an agent harness.
  'ITERM_SESSION_ID', // iTerm identifies its terminal session independently of the caller process.
  'XDG_SESSION_ID', // systemd identifies the user's login session, including ordinary terminals.
  'SHELL_SESSION_ID', // Konsole identifies an interactive shell session, not an agent harness.
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
  if (markers.length > 0) return { kind: 'unsupported-harness', markers }
  return { kind: 'operator' }
}

export function resolveCallerIdentity(
  caller: CallerClassification,
  operatorMachineId: string | null,
): CallerIdentityResolution {
  if (caller.kind === 'worker') return { kind: 'no-identity', reason: 'worker' }
  if (caller.kind === 'unsupported-harness')
    return { kind: 'no-identity', reason: 'unsupported-harness', markers: caller.markers }
  if (caller.kind === 'reserved-operator-session')
    return { kind: 'no-identity', reason: 'reserved-operator-prefix' }
  if (caller.kind === 'harness') return { kind: 'identity', session: caller.session }
  return operatorMachineId
    ? { kind: 'identity', session: `operator:${operatorMachineId}` }
    : { kind: 'no-identity', reason: 'operator-machine-id-missing' }
}

export function callerIdentityRefusal(
  resolution: CallerIdentityResolution,
  action: string,
): string {
  if (resolution.kind === 'identity') throw new Error('caller has an identity')
  if (resolution.reason === 'worker') return `this caller is a worker; a worker cannot ${action}`
  if (resolution.reason === 'unsupported-harness')
    return `this caller is an unsupported harness (${resolution.markers.join(', ')}); run the command from a terminal outside that harness`
  if (resolution.reason === 'reserved-operator-prefix')
    return 'this harness session uses the reserved operator: prefix; run the command from a terminal outside that harness'
  return 'this operator has no machine identity yet; run any orch command that opens the store for writing, then retry'
}
