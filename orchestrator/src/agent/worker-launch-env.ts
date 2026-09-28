// concern: worker-launch-env
/** Knows the user-context controls applied to worker harnesses. */

export function workerHarnessName(agent: { name: string; harness?: string }): string {
  return agent.harness ?? agent.name
}

export function workerLaunchEnv(harness: string): Record<string, string> {
  return harness === 'grok'
    ? {
        GROK_CLAUDE_AGENTS_ENABLED: '0',
        GROK_CLAUDE_HOOKS_ENABLED: '0',
        GROK_CLAUDE_MCPS_ENABLED: '0',
        GROK_CLAUDE_SKILLS_ENABLED: '0',
      }
    : {}
}
