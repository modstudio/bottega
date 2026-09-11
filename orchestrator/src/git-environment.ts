// concern: git-environment
/**
 * Knows hermetic git invocation and branch-ref observation; this is the future
 * home of worktree.ts's git-environment range. Must not know run state,
 * databases, routing, transports, or contracts.
 */
import { targetGitEnvironment } from './worktree.ts'

/** Read bounded git context without allowing observation failure to fail a run. */
export function gitContext(cwd: string, ...args: string[]): string | null {
  try {
    const p = Bun.spawnSync(['git', '-C', cwd, ...args],
      { env: targetGitEnvironment(cwd), stdout: 'pipe', stderr: 'ignore' })
    if (p.exitCode !== 0) return null
    const value = new TextDecoder().decode(p.stdout).trim()
    return value ? value.slice(0, 200) : null
  } catch { return null }
}

export function branchOf(cwd: string): string | null {
  const branch = gitContext(cwd, 'rev-parse', '--abbrev-ref', 'HEAD')
  return branch && branch !== 'HEAD' ? branch : null
}
