// concern: confined worker launch cwd decision.

export type ConfinedLaunchMode = 'attach' | 'create' | 'isolate' | 'caller'

/** Decide the directory a confined worker process starts in. */
export function confinedLaunchCwd(
  mode: ConfinedLaunchMode,
  worktreePath: string | null,
  isolatedDirectory: string,
  callerCwd: string,
): string {
  if (worktreePath) return worktreePath
  if (mode === 'isolate') return isolatedDirectory
  return callerCwd
}
