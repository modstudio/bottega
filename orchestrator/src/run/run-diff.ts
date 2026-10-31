// concern: run-diff
/** Knows run diff rendering. Must not know run control, transports, routing, the CLI, or worktrees by value. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { nulPathListArgs, splitNulPaths } from '../../../shared/git-path-list.ts'
import { db } from '../database/db.ts'
import { targetGitEnvironment } from '../git/git-environment.ts'
import { projectByName } from '../project/projects.ts'

type RunDiffFlags = { has(name: string): boolean }
type ArchitectRead = { tip: string; note: string; recordedAt: string }
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
    lowerBound?: string,
  ): Changes
  latestArchitectRead(project: string, branch: string): ArchitectRead | null
  commitAt(cwd: string, ref: string): string
  isAncestor(cwd: string, ancestor: string, descendant: string): boolean
  commitsBetween(cwd: string, since: string, tip: string): string
  exists(path: string): boolean
  withWorktreeLease<T>(repoRoot: string, worktreePath: string, action: () => T): T
  writesRepo(job: string): boolean
}

export type SinceReadDecision =
  | { kind: 'bound'; read: ArchitectRead }
  | { kind: 'refusal'; message: string }

export function validateRunDiffBounds(flags: RunDiffFlags): void {
  if (flags.has('since-read') && flags.has('since-base')) {
    throw new Error('--since-read and --since-base choose different lower bounds; use only one')
  }
}

export function chooseSinceReadBound(input: {
  runId: string
  branch: string
  read: ArchitectRead | null
  comparisonTip: string
  readIsAncestor: boolean
}): SinceReadDecision {
  if (!input.read) {
    return {
      kind: 'refusal',
      message:
        `no architect read is recorded for branch ${input.branch}\n` +
        `cleared by: record one with ${PLATFORM_SLUG} review read --note <note>, or run ${PLATFORM_SLUG} run diff ${input.runId} for the whole change`,
    }
  }
  if (!input.readIsAncestor) {
    return {
      kind: 'refusal',
      message:
        `architect read tip ${input.read.tip} is not an ancestor of comparison tip ${input.comparisonTip} for branch ${input.branch}\n` +
        `cleared by: run ${PLATFORM_SLUG} run diff ${input.runId} for the whole change`,
    }
  }
  return { kind: 'bound', read: input.read }
}

export function unchangedSinceReadMessage(read: ArchitectRead | null, diff: string): string | null {
  return read && !diff
    ? `no file changed since architect read ${read.tip} recorded ${read.recordedAt}`
    : null
}

export function commitAt(cwd: string, ref: string): string {
  const result = Bun.spawnSync(['git', 'rev-parse', '--verify', `${ref}^{commit}`], {
    cwd,
    env: targetGitEnvironment(cwd),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim())
  return result.stdout.toString().trim()
}

export function isAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  return (
    Bun.spawnSync(['git', 'merge-base', '--is-ancestor', ancestor, descendant], {
      cwd,
      env: targetGitEnvironment(cwd),
      stdout: 'ignore',
      stderr: 'ignore',
    }).exitCode === 0
  )
}

export function commitsBetween(cwd: string, since: string, tip: string): string {
  const result = Bun.spawnSync(['git', 'log', '--oneline', `${since}..${tip}`], {
    cwd,
    env: targetGitEnvironment(cwd),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim())
  return result.stdout.toString()
}

function evidenceLowerBound(input: {
  repoRoot: string
  evidenceBranch: string
  trunk: string
  configuredTrunk: string | undefined
  baseCommit: string
  sinceBase: boolean
  read: ArchitectRead | null
}): { since: string; usedRecordedFallback: boolean } {
  if (input.read) return { since: input.read.tip, usedRecordedFallback: false }
  if (input.sinceBase) return { since: input.baseCommit, usedRecordedFallback: true }
  const mergeBase = Bun.spawnSync(['git', 'merge-base', input.evidenceBranch, input.trunk], {
    cwd: input.repoRoot,
    env: targetGitEnvironment(input.repoRoot),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (mergeBase.exitCode === 0) {
    return { since: mergeBase.stdout.toString().trim(), usedRecordedFallback: false }
  }
  if (input.configuredTrunk) {
    throw new Error(`cannot find merge-base between the run tip and trunk ${input.trunk}`)
  }
  return { since: input.baseCommit, usedRecordedFallback: true }
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
  id: string,
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
    latestArchitectRead,
    commitAt,
    isAncestor,
    commitsBetween,
    exists,
    withWorktreeLease,
    writesRepo,
  } = presentation
  if (!id) usage()
  validateRunDiffBounds(flags)
  const row = db()
    .query(
      `SELECT record_id, repo, cwd, worktree, branch, branch_kept, base_commit,
            parent_run_record_id, carry_happened,
            carry_base_commit, carry_tracked_paths, carry_untracked_paths
       FROM run WHERE record_id = ?`,
    )
    .get(id) as {
    record_id: string
    repo: string | null
    cwd: string | null
    worktree: string | null
    branch: string | null
    branch_kept: string | null
    base_commit: string | null
    parent_run_record_id: string | null
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
  const project = row.repo ? projectByName(row.repo) : null
  if (has('since-read') && !project) {
    throw new Error(`run ${id}'s registered project was not found`)
  }
  const sinceReadFor = (branch: string, comparisonTip: string, cwd: string) => {
    if (!has('since-read')) return null
    const read = latestArchitectRead(project!.name, branch)
    const decision = chooseSinceReadBound({
      runId: id,
      branch,
      read,
      comparisonTip,
      readIsAncestor: Boolean(read && isAncestor(cwd, read.tip, comparisonTip)),
    })
    if (decision.kind === 'refusal') throw new Error(decision.message)
    return decision.read
  }
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
      const configuredTrunk = project?.settings.trunk?.trim()
      const trunk = configuredTrunk || 'main'
      const comparisonTip = commitAt(repoRoot, evidenceBranch)
      const read = sinceReadFor(evidenceBranch, comparisonTip, repoRoot)
      const { since, usedRecordedFallback } = evidenceLowerBound({
        repoRoot,
        evidenceBranch,
        trunk,
        configuredTrunk,
        baseCommit,
        sinceBase: has('since-base'),
        read,
      })
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
      const names = splitNulPaths(
        Bun.spawnSync(['git', ...nulPathListArgs(['diff', '--name-only', since, evidenceBranch])], {
          cwd: repoRoot,
          env: targetGitEnvironment(repoRoot),
          stdout: 'pipe',
          stderr: 'pipe',
        }).stdout.toString(),
      )
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
        files: names,
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
        : read
          ? 'architect read; worktree discarded'
          : `trunk ${trunk}; worktree discarded`
      return { c, commits, sinceNote, read }
    },
    readLive: (worktreePath) => {
      const branch = row.branch ?? `orch/${id}`
      const comparisonTip = commitAt(worktreePath, 'HEAD')
      const read = sinceReadFor(branch, comparisonTip, worktreePath)
      const c = observedChangesIn(
        {
          path: worktreePath,
          branch,
          base: baseCommit,
          repoRoot,
        },
        has('since-base'),
        read?.tip,
      )
      const commits = commitsBetween(worktreePath, c.since, 'HEAD')
      const sinceNote = has('since-base')
        ? 'recorded; --since-base'
        : read
          ? 'architect read'
          : `trunk ${c.trunk}${c.trunkConfigured ? '' : '; register fallback'}`
      return { c, commits, sinceNote, read }
    },
  })
  const { c, commits, sinceNote, read } = result
  const runKind = db().query('SELECT job FROM run WHERE record_id=?').get(id) as { job: string }
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
  if (read) {
    write(`read commit: ${read.tip}\n`)
    write(`read recorded: ${read.recordedAt}\n`)
    write(`read note: ${read.note}\n`)
  }
  write('commits:\n')
  write(commits || '(none)\n')
  const unchanged = unchangedSinceReadMessage(read, c.diff)
  if (unchanged) write(`${unchanged}\n`)
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
        `\n  discard:  ${PLATFORM_SLUG} run discard ${row.parent_run_record_id ?? id}`,
    )
  }
  return
}
