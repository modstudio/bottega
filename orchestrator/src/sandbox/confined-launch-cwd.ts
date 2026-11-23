// concern: confined worker launch cwd decision.

export type ConfinedLaunchMode = 'attach' | 'create' | 'isolate' | 'caller'

/** Decide the directory a confined worker process starts in. */
export function confinedLaunchCwd(
  mode: ConfinedLaunchMode,
  worktreePath: string,
  isolatedDirectory: string,
  callerCwd: string,
): string {
  if (mode === 'attach' || mode === 'create') return worktreePath
  if (mode === 'isolate') return isolatedDirectory
  return callerCwd
}
