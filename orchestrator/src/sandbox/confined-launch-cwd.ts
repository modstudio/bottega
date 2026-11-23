// concern: confined worker launch cwd decision.

export type ConfinedLaunchMode = 'attach' | 'create' | 'isolate' | 'caller'

/** Decide the directory a confined worker process starts in. */
export function confinedLaunchCwd(input: {
  mode: ConfinedLaunchMode
  worktreePath: string
  isolatedDirectory: string
  callerCwd: string
}): string {
  if (input.mode === 'attach' || input.mode === 'create') return input.worktreePath
  if (input.mode === 'isolate') return input.isolatedDirectory
  return input.callerCwd
}
