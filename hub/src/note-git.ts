import { gitAt } from '../../shared/git.ts'

export function noteGit(cwd: string, ...args: string[]): string | null {
  const result = gitAt(cwd, args)
  if (result.timedOut)
    throw new Error(
      `git ${args.join(' ')} exceeded its bounded-call deadline; retry the note command`,
    )
  return result.code === 0 ? result.stdout.trim() : null
}
