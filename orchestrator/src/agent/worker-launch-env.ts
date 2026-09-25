// concern: worker-launch-env
/** Knows the user-context controls applied to worker harnesses. */

export function workerLaunchEnv(agentName: string): Record<string, string> {
  return agentName === 'grok' ? { GROK_CLAUDE_AGENTS_ENABLED: '0' } : {}
}
