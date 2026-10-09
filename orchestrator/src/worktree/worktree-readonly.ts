// concern: worktree-readonly
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  borrowedCheckoutOf,
  git,
  gitInput,
  gitOk,
  repoRootOf,
  targetGitEnvironment,
} from '../git/git-environment.ts'
import type { WorktreeTool } from '../project/projects.ts'
import {
  attributeWorktree,
  type RecordWorktree,
  runCreateTool,
  verifyFreshWorktree,
} from './worktree-create.ts'
import { provisionWorktree, type WorktreeProvision } from './worktree-provision.ts'
import { branchTip, removeReadOnlyDirectory, removeReadOnlyTree } from './worktree-remove.ts'
import { assertCreateVarsAvailable } from './worktree-template.ts'
import type { Worktree } from './worktree-types.ts'

export function createReadOnlyWorktree(
  cwd: string,
  runId: number,
  base: string,
  record?: RecordWorktree,
  provision: WorktreeProvision = [],
  provisionTimeoutMs?: number,
): Worktree {
  const repoRoot = repoRootOf(cwd)
  if (!repoRoot) throw new Error(`not a git repository: ${cwd}`)
  const path = join(repoRoot, '.claude', 'worktrees', `orch-${runId}`)
  mkdirSync(dirname(path), { recursive: true })
  if (existsSync(path))
    throw new Error(`worktree ${path} already exists; run ${runId} would overwrite it`)
  const worktree = { path, branch: '', base, repoRoot, source: 'clone' as const }
  try {
    const remoteTrackingRefs = snapshotRemoteTrackingRefs(repoRoot)
    git(['clone', '--shared', '--no-checkout', repoRoot, path], repoRoot)
    git(['checkout', '--detach', base], path)
    git(['remote', 'remove', 'origin'], path)
    restoreRemoteTrackingRefs(path, remoteTrackingRefs)
    provisionWorktree(repoRoot, path, provision, 'the project register row', provisionTimeoutMs)
    attributeWorktree(worktree, runId, record)
    verifyFreshWorktree(worktree)
    verifyBorrowedCheckout(path, repoRoot)
    return worktree
  } catch (error) {
    const cleanup = removeReadOnlyDirectory(worktree)
    if (cleanup.removed) throw error
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\ncleanup: ${cleanup.detail}`,
    )
  }
}

type RemoteTrackingRef = { ref: string; object: string }

/** Preserve revision names reviewers can see without preserving a usable transport. */
function snapshotRemoteTrackingRefs(repoRoot: string): RemoteTrackingRef[] {
  const output = git(
    ['for-each-ref', '--format=%(refname)%09%(objectname)', 'refs/remotes/'],
    repoRoot,
  )
  if (!output) return []
  return output.split('\n').map((line) => {
    const fields = line.split('\t')
    const ref = fields[0]
    const object = fields[1]
    if (!ref || !object) throw new Error(`git for-each-ref returned malformed line: ${line}`)
    return { ref, object }
  })
}

function restoreRemoteTrackingRefs(path: string, refs: RemoteTrackingRef[]): void {
  if (!refs.length) return
  const updates = `${refs.map((ref) => `update ${ref.ref} ${ref.object}`).join('\n')}\n`
  gitInput(['update-ref', '--stdin'], path, new TextEncoder().encode(updates))
}

/** Let a project provision a detached read-only checkout at orch's chosen path. */
export function createReadOnlyWithTool(
  tool: WorktreeTool,
  cwd: string,
  runId: number,
  base: string,
  record?: RecordWorktree,
): Worktree {
  const repoRoot = repoRootOf(cwd)
  if (!repoRoot) throw new Error(`not a git repository: ${cwd}`)
  if (!tool.readonly_create) throw new Error('project declares no readonly_create command')
  const path = join(repoRoot, '.claude', 'worktrees', `orch-${runId}`)
  if (existsSync(path))
    throw new Error(`worktree ${path} already exists; run ${runId} would overwrite it`)
  const vars = { path, base }
  assertCreateVarsAvailable(tool.readonly_create, vars)
  const branchesBefore = localBranchTips(repoRoot)
  const result = runCreateTool(tool.readonly_create, vars, repoRoot, targetGitEnvironment(cwd))
  let branch = ''
  try {
    if (!result.ok)
      throw new Error(`the project's read-only worktree tool failed:\n${result.out.slice(-1500)}`)
    if (!existsSync(path)) {
      throw new Error(
        `the project's read-only worktree tool reported success but ${path} does not exist`,
      )
    }
    branch = gitOk(['symbolic-ref', '--quiet', '--short', 'HEAD'], path) ?? ''
    if (branch)
      throw new Error(`the project's read-only worktree tool created attached branch ${branch}`)
    const worktree = {
      path,
      branch: '',
      base,
      repoRoot,
      source: 'readonly_recipe' as const,
      mintedBranch: null,
    }
    attributeWorktree(worktree, runId, record)
    verifyFreshWorktree(worktree)
    verifyBorrowedCheckout(path, repoRoot)
    return worktree
  } catch (error) {
    if (!existsSync(path)) throw error
    const previousTip = branch ? branchesBefore.get(branch) : undefined
    const cleanup = removeReadOnlyTree(
      tool,
      {
        path,
        branch,
        base,
        repoRoot,
        source: 'readonly_recipe',
      },
      previousTip !== undefined,
    )
    if (cleanup.removed && branch && previousTip !== undefined) {
      const restored = restoreBranchToTip(repoRoot, branch, previousTip)
      if (!restored.ok) {
        cleanup.removed = false
        cleanup.detail =
          `${cleanup.detail}; could not restore pre-existing branch ${branch} ` +
          `to ${previousTip}: ${restored.error}`
      }
    }
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n` +
        `cleanup: ${cleanup.removed ? 'removed' : cleanup.detail}`,
    )
  }
}

/** Enforce the generic readonly_create contract after either creation path. */
function verifyBorrowedCheckout(path: string, repoRoot: string): void {
  const source = borrowedCheckoutOf(path)
  if (!source || source !== repoRoot) {
    throw new Error(
      `read-only checkout ${path} does not borrow objects from main checkout ${repoRoot}`,
    )
  }
}

function localBranchTips(repoRoot: string): Map<string, string> {
  const lines = git(
    ['for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads/'],
    repoRoot,
  )
  return new Map(
    lines
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const split = line.lastIndexOf(' ')
        return [line.slice(0, split), line.slice(split + 1)]
      }),
  )
}

function restoreBranchToTip(
  repoRoot: string,
  branch: string,
  tip: string,
): { ok: true } | { ok: false; error: string } {
  const current = branchTip(repoRoot, branch)
  if (current === tip) return { ok: true }
  const expected = current ?? '0000000000000000000000000000000000000000'
  const p = Bun.spawnSync(['git', 'update-ref', `refs/heads/${branch}`, tip, expected], {
    cwd: repoRoot,
    env: targetGitEnvironment(repoRoot),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return p.exitCode === 0
    ? { ok: true }
    : { ok: false, error: p.stderr.toString().trim() || `exit ${p.exitCode}` }
}

/** Refuse a newly created tree whose files or index do not exactly describe HEAD. */
