// concern: run-diff
/** Knows run diff rendering. Must not know run control, transports, routing, the CLI, or worktrees by value. */
import { db } from '../database/db.ts'
import { targetGitEnvironment } from '../git/git-environment.ts'
import { projectByName } from '../project/projects.ts'

type RunDiffFlags = { has(name: string): boolean }
type Changes = {
  diff: string
  files: string[]
  insertions: number
  deletions: number
  since: string
  trunk: string
  trunkConfigured: boolean
}
type RunDiffPresentation = {
  error(...values: unknown[]): void
  write(value: string): void
  usage(): never
  cleanupRepoRoot(row: {
    repo: string | null
    cwd: string | null
    worktree: string | null
  }): string | null
  observedChangesIn(
    spec: { path: string; branch: string; base: string; repoRoot: string },
    sinceBase: boolean,
  ): Changes
  exists(path: string): boolean
  withWorktreeLease<T>(repoRoot: string, worktreePath: string, action: () => T): T
  writesRepo(job: string): boolean
}

export function readRunDiffSource<T>(input: {
  repoRoot: string
  worktree: string | null
  exists(path: string): boolean
  withWorktreeLease<T>(repoRoot: string, worktreePath: string, action: () => T): T
  readLive(worktreePath: string): T
  readEvidence(): T
}): T {
  if (!input.worktree) return input.readEvidence()
  const selected = input.withWorktreeLease(input.repoRoot, input.worktree, () =>
    input.exists(input.worktree!)
      ? { kind: 'live' as const, value: input.readLive(input.worktree!) }
      : { kind: 'evidence' as const },
  )
  return selected.kind === 'live' ? selected.value : input.readEvidence()
}

export async function runDiffCommand(
  id: number,
  flags: RunDiffFlags,
  presentation: RunDiffPresentation,
): Promise<void> {
  const { has } = flags
  const {
    error,
    write,
    usage,
    cleanupRepoRoot,
    observedChangesIn,
    exists,
    withWorktreeLease,
    writesRepo,
  } = presentation
  if (!id) usage()
  const row = db()
    .query(
      `SELECT id, repo, cwd, worktree, branch, branch_kept, base_commit,
            parent_run_id, carry_happened,
            carry_base_commit, carry_tracked_paths, carry_untracked_paths
       FROM run WHERE id = ?`,
    )
    .get(id) as {
    id: number
    repo: string | null
    cwd: string | null
    worktree: string | null
    branch: string | null
    branch_kept: string | null
    base_commit: string | null
    parent_run_id: number | null
    carry_happened: number | null
    carry_base_commit: string | null
    carry_tracked_paths: string | null
    carry_untracked_paths: string | null
  } | null
  if (!row) throw new Error(`no run ${id}`)
  if (!row.base_commit) throw new Error(`run ${id} recorded no base commit to diff against`)
  const baseCommit = row.base_commit
  const repoRoot = cleanupRepoRoot(row)
  if (!repoRoot) throw new Error(`run ${id}'s repository root was not found`)
  const evidenceBranch = row.branch_kept ?? row.branch
  const result = readRunDiffSource({
    repoRoot,
    worktree: row.worktree,
    exists,
    withWorktreeLease,
    readEvidence: () => {
      const branchPresent = Boolean(
        evidenceBranch &&
          Bun.spawnSync(
            ['git', 'show-ref', '--verify', '--quiet', `refs/heads/${evidenceBranch}`],
            {
              cwd: repoRoot,
              env: targetGitEnvironment(repoRoot),
              stdout: 'ignore',
              stderr: 'ignore',
            },
          ).exitCode === 0,
      )
      if (!branchPresent || !evidenceBranch) {
        throw new Error(`run ${id}'s worktree and evidence branch are gone`)
      }
      const project = row.repo ? projectByName(row.repo) : null
      const configuredTrunk = project?.settings.trunk?.trim()
      const trunk = configuredTrunk || 'main'
      let since = baseCommit
      let usedRecordedFallback = has('since-base')
      if (!has('since-base')) {
        const mergeBase = Bun.spawnSync(['git', 'merge-base', evidenceBranch, trunk], {
          cwd: repoRoot,
          env: targetGitEnvironment(repoRoot),
          stdout: 'pipe',
          stderr: 'pipe',
        })
        if (mergeBase.exitCode === 0) {
          since = mergeBase.stdout.toString().trim()
          usedRecordedFallback = false
        } else if (configuredTrunk) {
          throw new Error(`cannot find merge-base between the run tip and trunk ${trunk}`)
        } else {
          usedRecordedFallback = true
        }
      }
      const diff = Bun.spawnSync(
        ['git', 'diff', '--no-ext-diff', '--binary', since, evidenceBranch],
        {
          cwd: repoRoot,
          env: targetGitEnvironment(repoRoot),
          stdout: 'pipe',
          stderr: 'pipe',
        },
      )
      if (diff.exitCode !== 0) throw new Error(diff.stderr.toString().trim())
      const names = Bun.spawnSync(['git', 'diff', '--name-only', since, evidenceBranch], {
        cwd: repoRoot,
        env: targetGitEnvironment(repoRoot),
        stdout: 'pipe',
        stderr: 'pipe',
      })
        .stdout.toString()
        .trim()
      const stat = Bun.spawnSync(['git', 'diff', '--numstat', since, evidenceBranch], {
        cwd: repoRoot,
        env: targetGitEnvironment(repoRoot),
        stdout: 'pipe',
        stderr: 'pipe',
      })
        .stdout.toString()
        .trim()
      let insertions = 0
      let deletions = 0
      for (const line of stat.split('\n')) {
        const [add, del] = line.split('\t')
        insertions += Number(add) || 0
        deletions += Number(del) || 0
      }
      const c = {
        diff: diff.stdout.toString(),
        files: names ? names.split('\n') : [],
        insertions,
        deletions,
        since,
        trunk,
        trunkConfigured: Boolean(configuredTrunk),
      }
      const logged = Bun.spawnSync(['git', 'log', '--oneline', `${since}..${evidenceBranch}`], {
        cwd: repoRoot,
        env: targetGitEnvironment(repoRoot),
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const commits = logged.exitCode === 0 ? logged.stdout.toString() : ''
      const sinceNote = usedRecordedFallback
        ? `${has('since-base') ? 'recorded; --since-base' : 'recorded fallback'}; worktree discarded`
        : `trunk ${trunk}; worktree discarded`
      return { c, commits, sinceNote }
    },
    readLive: (worktreePath) => {
      const c = observedChangesIn(
        {
          path: worktreePath,
          branch: row.branch ?? `orch/${id}`,
          base: baseCommit,
          repoRoot,
        },
        has('since-base'),
      )
      const logged = Bun.spawnSync(['git', 'log', '--oneline', `${c.since}..HEAD`], {
        cwd: worktreePath,
        env: targetGitEnvironment(worktreePath),
        stdout: 'pipe',
        stderr: 'pipe',
      })
      if (logged.exitCode !== 0) throw new Error(logged.stderr.toString().trim())
      const commits = logged.stdout.toString()
      const sinceNote = has('since-base')
        ? 'recorded; --since-base'
        : `trunk ${c.trunk}${c.trunkConfigured ? '' : '; register fallback'}`
      return { c, commits, sinceNote }
    },
  })
  const { c, commits, sinceNote } = result
  const runKind = db().query('SELECT job FROM run WHERE id=?').get(id) as { job: string }
  if (!writesRepo(runKind.job)) {
    error(
      `WARNING: run ${id} is a review/read job. Its findings are the product; this diff ` +
        `contains review input and scratch experiments and must not be landed.`,
    )
  }
  // A patch preamble is ignored by `git apply`, while keeping the base in the
  // stdout artifact even under --quiet or when stderr is not captured.
  write(`base: ${row.base_commit} (recorded)\n`)
  write(`since: ${c.since} (${sinceNote})\n`)
  write('commits:\n')
  write(commits || '(none)\n')
  if (
    row.carry_happened !== null &&
    row.carry_base_commit &&
    row.carry_tracked_paths !== null &&
    row.carry_untracked_paths !== null
  ) {
    const tracked = JSON.parse(row.carry_tracked_paths) as string[]
    const untracked = JSON.parse(row.carry_untracked_paths) as string[]
    write(
      row.carry_happened
        ? `carry: ${tracked.length} tracked path(s), ${untracked.length} untracked path(s)\n` +
            `carry base: ${row.carry_base_commit}\n` +
            tracked.map((path) => `carry tracked: ${JSON.stringify(path)}\n`).join('') +
            untracked.map((path) => `carry untracked: ${JSON.stringify(path)}\n`).join('')
        : `carry: none (0 tracked paths, 0 untracked paths)\ncarry base: ${row.carry_base_commit}\n`,
    )
  }
  // write(), not console.log(): this output is piped into `git apply`, and a
  // newline added to the diff for readability is a byte the patch did not have.
  write(c.diff)
  if (!has('quiet')) {
    error(
      `\n— run ${id} · ${c.files.length} file(s) · +${c.insertions}/-${c.deletions}` +
        `\n  base:     ${row.base_commit}` +
        `\n  worktree: ${row.worktree}` +
        // The ROOT owns the worktree. Discarding a child would clear that one
        // row's pointer and leave the root still naming a directory that had
        // just been deleted.
        `\n  discard:  orch discard ${row.parent_run_id ?? id}`,
    )
  }
  return
}
