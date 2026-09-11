// concern: task-branch
/**
 * Knows the project register, branch content status, and database reads. Must
 * not know transports, contracts, or routing.
 */
import { db } from './db.ts'
import { projectAt, projects } from './projects.ts'
import { reviewRunEvidenceSql } from './review.ts'
import {
  type Worktree } from './worktree.ts'
import { repoRootOf, targetGitEnvironment } from './git-environment.ts'
import { realpathOrSpelled } from './checkout-identity.ts'

export type TaskBranchCandidate = {
  branch: string
  tip: string
  commitCount: number
  mergeBase: string
  projectId: number
  projectName: string
  runIds: number[]
  worktree: Worktree | null
}

export function taskBranchCandidacySql(runAlias = 'candidate'): string {
  return `${runAlias}.status <> 'stopped'`
}

function taskBranchGit(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(['git', '-C', cwd, ...args], {
    env: targetGitEnvironment(cwd), stdout: 'pipe', stderr: 'pipe',
  })
  if (p.exitCode !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed while resolving the task branch: ` +
      (p.stderr.toString().trim() || `exit ${p.exitCode}`),
    )
  }
  return p.stdout.toString().trim()
}

function checkedOutWorktree(repoRoot: string, branch: string): string | null {
  let path: string | null = null
  for (const line of taskBranchGit(repoRoot, 'worktree', 'list', '--porcelain').split('\n')) {
    if (line.startsWith('worktree ')) path = line.slice('worktree '.length)
    else if (line === `branch refs/heads/${branch}`) return path
    else if (!line) path = null
  }
  return null
}

export function resolveTaskBranch(cwd: string, launchKey: string): TaskBranchCandidate | null {
  const repoRoot = repoRootOf(cwd)
  const project = projectAt(cwd) ?? (repoRoot
    ? projects().find((candidate) =>
        realpathOrSpelled(candidate.path) === realpathOrSpelled(repoRoot)) ?? null
    : null)
  if (!project || !repoRoot) return null
  const rows = db().query(
    `WITH candidate AS (SELECT run.*, run.id AS run_id FROM run)
     SELECT candidate.id, candidate.branch, candidate.worktree,
            candidate.worktree_source
       FROM candidate
      WHERE candidate.launch_key=?
        AND (candidate.project_id=? OR (candidate.project_id IS NULL AND candidate.repo=?))
        AND candidate.branch IS NOT NULL
        AND ${taskBranchCandidacySql('candidate')}
        AND ${reviewRunEvidenceSql('candidate', 'candidate')}
      ORDER BY candidate.id`,
  ).all(launchKey, project.id, project.name) as {
    id: number
    branch: string
    worktree: string | null
    worktree_source: string | null
  }[]
  if (rows.length === 0) return null

  const trunk = project.settings.trunk?.trim()
  if (!trunk) {
    throw new Error(
      `project ${project.name} has no trunk configured; task branch content cannot be resolved`,
    )
  }

  const byBranch = new Map<string, typeof rows>()
  for (const row of rows) byBranch.set(row.branch, [...(byBranch.get(row.branch) ?? []), row])
  const trunkTip = taskBranchGit(repoRoot, 'rev-parse', '--verify', '--end-of-options', `${trunk}^{commit}`)
  const candidates: TaskBranchCandidate[] = []
  for (const [branch, branchRows] of byBranch) {
    let tip: string
    try {
      tip = taskBranchGit(
        repoRoot, 'rev-parse', '--verify', '--end-of-options', `refs/heads/${branch}^{commit}`,
      )
    } catch {
      continue
    }
    const mergeBase = taskBranchGit(repoRoot, 'merge-base', trunkTip, tip)
    const commitCount = Number(taskBranchGit(repoRoot, 'rev-list', '--count', `${mergeBase}..${tip}`))
    if (!Number.isSafeInteger(commitCount) || commitCount < 1) continue

    // The two supported landing shapes leave different patch-id evidence.
    // Preserve the original commits for a multi-commit cherry-pick, then also
    // compare the net patch for a squash landing. An ancestry-only merged check
    // cannot see either and must not decide task ownership.
    const individual = taskBranchGit(repoRoot, 'cherry', trunkTip, tip)
    if (!individual.split('\n').some((line) => line.startsWith('+ '))) continue
    const tree = taskBranchGit(repoRoot, 'rev-parse', '--verify', `${tip}^{tree}`)
    const squash = taskBranchGit(
      repoRoot, 'commit-tree', tree, '-p', mergeBase, '-m', `orch task branch ${launchKey}`,
    )
    const cherry = taskBranchGit(repoRoot, 'cherry', trunkTip, squash)
    if (!cherry.split('\n').some((line) => line.startsWith('+ '))) continue

    const path = checkedOutWorktree(repoRoot, branch)
    const attachedRow = path ? branchRows.find((row) =>
      row.worktree && realpathOrSpelled(row.worktree) === realpathOrSpelled(path),
    ) : null
    const source = attachedRow?.worktree_source
    candidates.push({
      branch, tip, commitCount, mergeBase,
      projectId: project.id, projectName: project.name,
      runIds: branchRows.map((row) => row.id),
      worktree: path ? {
        path, branch, base: tip, repoRoot,
        source: source === 'recipe' || source === 'git' || source === 'readonly_recipe'
          ? source
          : undefined,
        // Null records that this run attached; it did not mint the task branch.
        mintedBranch: null,
      } : null,
    })
  }

  if (candidates.length === 0) return null
  if (candidates.length === 1) return candidates[0]!
  const detail = candidates.map((candidate) =>
    `  ${candidate.branch} tip ${candidate.tip} commits ${candidate.commitCount}`,
  ).join('\n')
  const commands = candidates.map((kept) => {
    const voidCommands = candidates.filter((candidate) => candidate !== kept)
      .flatMap((candidate) => candidate.runIds)
      .map((id) => `    orch score ${id} --void --note "not the live ${launchKey} branch"`)
      .join('\n')
    return `  To keep ${kept.branch}:\n${voidCommands}`
  }).join('\n')
  throw new Error(
    `refusing task branch resolution for ${launchKey}: more than one branch carries content not on ${trunk}\n` +
    `${detail}\n` +
    `invariant: A task owns one branch.\n` +
    `Clear the ambiguity by choosing one branch and voiding the candidate runs behind the others:\n${commands}`,
  )
}
