// concern: harness session publication decisions

export type HarnessProcessIdentity = { pid: number; startTime: string }
export type HarnessProcessFact = { pid: number; command: string }
export type HarnessProcessIdentityState = 'live' | 'dead' | 'reused' | 'unknown'

export type HarnessSessionPublication = {
  identity: HarnessProcessIdentity
  session: string
  harness: 'claude-code'
  source: string
  published_at: string
}

export type HarnessSessionDisposition = 'reap' | 'keep' | 'unknown'

/** Decide how storage treats a publication after observing its process identity. */
export function harnessSessionDisposition(
  identity: HarnessProcessIdentityState,
): HarnessSessionDisposition {
  if (identity === 'dead' || identity === 'reused') return 'reap'
  if (identity === 'live') return 'keep'
  return 'unknown'
}

/** Whether the first command token names the Claude harness executable. */
export function isClaudeHarness(process: Pick<HarnessProcessFact, 'command'>): boolean {
  const executable = process.command.trim().split(/\s+/, 1)[0] ?? ''
  return executable.split('/').at(-1) === 'claude'
}

/** Find live Claude harness processes whose pid has no publication proven live by the reaper. */
export function unpublishedHarnessProcesses(
  processes: readonly HarnessProcessFact[],
  publications: readonly Pick<HarnessSessionPublication, 'identity'>[],
): HarnessProcessFact[] {
  const published = new Set(publications.map(({ identity }) => identity.pid))
  return processes.filter(isClaudeHarness).filter(({ pid }) => !published.has(pid))
}
