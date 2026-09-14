import { afterEach, beforeEach } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WorktreeCreate, WorktreeCreateArg } from '../../src/worktree-template.ts'
import { testSpawnSync } from '../preload.ts'
import { hermeticGitEnv } from './git.ts'

export const declaredCreate = (command: string, args: WorktreeCreateArg[]): WorktreeCreate =>
  ({ command, args })
export const compoundCreate = (script: string): WorktreeCreate =>
  ({ command: 'sh', args: ['-c', script] })
export function worktreeDescribeFixture() {
  let priorCleanupSession: string | undefined
  beforeEach(() => {
    priorCleanupSession = process.env.CLAUDE_CODE_SESSION_ID
    process.env.CLAUDE_CODE_SESSION_ID = 'worktree-owner-session'
  })
  afterEach(() => {
    if (priorCleanupSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
    else process.env.CLAUDE_CODE_SESSION_ID = priorCleanupSession
  })
  const fromRoot = <T>(fn: () => T): T => {
    const priorDepth = process.env.ORCH_DEPTH
    try { process.env.ORCH_DEPTH = '0'; return fn() } finally {
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
    }
  }
  const git = (cwd: string, ...args: string[]) => {
    const result = testSpawnSync(['git', ...args], {
      cwd, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
    })
    if (result.exitCode !== 0) throw new Error(result.stderr.toString())
    return result.stdout.toString().trim()
  }
  function scratchRepo(): { repo: string; tree: string } {
    const repo = mkdtempSync(join(tmpdir(), 'orch-nested-'))
    git(repo, 'init', '-b', 'main'); git(repo, 'config', 'user.email', 'orch-test@example.invalid')
    git(repo, 'config', 'user.name', 'Orch Test'); writeFileSync(join(repo, 'kept.txt'), 'base\n')
    git(repo, 'add', 'kept.txt'); git(repo, 'commit', '-m', 'base')
    const tree = join(repo, '.claude', 'worktrees', 'AB-2581')
    mkdirSync(join(repo, '.claude', 'worktrees'), { recursive: true })
    git(repo, 'worktree', 'add', '-b', 'AB-2581', tree, 'main')
    return { repo, tree }
  }
  function markScratchRepoOwner(repo: string, tree: string, runId: number): void {
    appendFileSync(join(repo, '.git', 'info', 'exclude'), '.orch-run\n')
    writeFileSync(join(tree, '.orch-run'), `${runId}\n${repo}\nsource: git\n`)
  }
  return { priorCleanupSession, fromRoot, git, scratchRepo, markScratchRepoOwner }
}
