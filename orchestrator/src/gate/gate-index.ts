// concern: isolated worker-gate index
/** Presents a run's current tree as staged without changing its real index, HEAD, or branch. */

import { rmSync } from 'node:fs'
import { scrubbedGitEnv } from '../../../shared/git.ts'
import { WORKER_GATE_BASE_ENV } from './gate-decision.ts'

function runGit(worktree: string, indexPath: string, args: string[]): void {
  const result = Bun.spawnSync(['git', '-C', worktree, '--no-optional-locks', ...args], {
    env: { ...scrubbedGitEnv(), GIT_INDEX_FILE: indexPath },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) {
    throw new Error(
      `synthetic gate index failed at git ${args[0]}: ${result.stderr.toString().trim() || `exit ${result.exitCode}`}`,
    )
  }
}

export function prepareSyntheticGateIndex(input: {
  worktree: string
  baseCommit: string
  indexPath: string
}): Record<string, string> {
  rmSync(input.indexPath, { force: true })
  rmSync(`${input.indexPath}.lock`, { force: true })
  runGit(input.worktree, input.indexPath, ['read-tree', input.baseCommit])
  runGit(input.worktree, input.indexPath, ['add', '-A', '--'])
  return {
    GIT_INDEX_FILE: input.indexPath,
    [WORKER_GATE_BASE_ENV]: input.baseCommit,
  }
}

export function removeSyntheticGateIndex(indexPath: string): void {
  rmSync(indexPath, { force: true })
  rmSync(`${indexPath}.lock`, { force: true })
}
