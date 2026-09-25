// concern: worker-launch-env
/** Knows the user-context controls applied to worker harnesses. */

export function workerLaunchEnv(harness: string): Record<string, string> {
  return harness === 'grok'
    ? { GROK_CLAUDE_AGENTS_ENABLED: '0', GROK_CLAUDE_HOOKS_ENABLED: '0' }
    : {}
}
