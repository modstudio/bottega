// concern: record-connection-env
/**
 * Names of record database connection variables, the child-env forward filter
 * that withholds them, and the worker resolver guard. Must not read values,
 * homes, or the hosted record.
 */

export const RECORD_CONNECTION_ENV_NAMES = new Set(['ORCH_RECORD_URL', 'ORCH_RECORD_MIGRATE_URL'])

export const RECORD_CONNECTION_WORKER_REFUSAL =
  'record database connections are withheld from workers; the architect session runs work that needs one'

const ALLOW_ENV_EXACT = new Set([
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'LANG',
  'TERM',
  'TMPDIR',
  'SSH_AUTH_SOCK',
])
const ALLOW_ENV_PREFIX = /^(LC_|XDG_|OPENAI_|XAI_|GROK_|GEMINI_|GOOGLE_|CODEX_|QWEN_|ORCH_)/

/** Whether childEnv forwards this parent variable name into a vendor process. */
export function isForwardedChildEnvName(name: string): boolean {
  if (RECORD_CONNECTION_ENV_NAMES.has(name)) return false
  return ALLOW_ENV_EXACT.has(name) || ALLOW_ENV_PREFIX.test(name)
}

/** Withheld-class names that the child-env filter would still forward. */
export function withheldClassNamesForwardedFrom(envNames: readonly string[]): string[] {
  return envNames
    .filter((name) => RECORD_CONNECTION_ENV_NAMES.has(name) && isForwardedChildEnvName(name))
    .sort()
}

export function recordConnectionResolverRefusal(name: string, depthSet: boolean): string | null {
  if (!depthSet || !RECORD_CONNECTION_ENV_NAMES.has(name)) return null
  return `${name}: ${RECORD_CONNECTION_WORKER_REFUSAL}`
}

export function assertRecordConnectionResolutionAllowed(
  names: readonly string[],
  env: Record<string, string | undefined>,
): void {
  for (const name of names) {
    const refusal = recordConnectionResolverRefusal(name, env.ORCH_DEPTH !== undefined)
    if (refusal) throw new Error(refusal)
  }
}
