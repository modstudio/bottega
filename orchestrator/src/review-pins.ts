// concern: review-pins
import type { Database } from 'bun:sqlite'
import { db, writableDb } from './db.ts'
import { targetGitEnvironment } from './git-environment.ts'
import { changeIdentity } from './change-identity.ts'
import type { CoverageGitRunner, ReviewChangeRange, ReviewPin, RunRow } from './review-types.ts'

export function reviewChangeRange(run: Pick<RunRow,
  'base_commit' | 'input_tree' | 'head_commit' | 'review_ref' | 'changed_paths'
>): ReviewChangeRange | null {
  if (!run.base_commit) return null
  if (run.changed_paths !== null && run.input_tree) {
    const paths = JSON.parse(run.changed_paths)
    if (!Array.isArray(paths) || paths.some((path) => typeof path !== 'string')) {
      throw new Error('run changed_paths is not a JSON array of paths')
    }
    return { from: run.base_commit, to: run.input_tree, paths }
  }
  // An implicit carried review has no explicit changed-path snapshot, but its
  // committed range is empty while the launch-time input tree contains the
  // reviewed overlay. Preserve that existing clean-review fallback.
  const fallback = run.head_commit === run.base_commit && run.input_tree
    ? run.input_tree
    : run.head_commit ?? run.input_tree
  return fallback ? { from: run.base_commit, to: fallback, paths: null } : null
}

function tierForRuns(runs: RunRow[], database: Database): ReviewTier | null {
  const bases = new Map(runs.map((run) => [run.id, run.base_commit]))
  const trees = new Map(runs.map((run) => [run.id, run.input_tree]))
  const distinctBases = new Set(bases.values())
  const distinctTrees = new Set(trees.values())
  const differ = (values: Map<number, string | null>) => [...values].map(([id, value]) =>
    `run ${id}=${value ?? 'NULL'}`).join(', ')
  if (distinctBases.size !== 1 || distinctTrees.size !== 1) {
    console.error(`warning: review tier not recorded: lens runs differ (${differ(bases)}; ${differ(trees)})`)
    return null
  }
  try {
    for (const run of runs) {
      if (!run.base_commit || !run.input_tree || !run.repo) {
        throw new Error(`run ${run.id} lacks base_commit, input_tree, or repo`)
      }
      const repo = projectPath(database, run.repo)
      if (!repo) throw new Error(`run ${run.id} project ${run.repo} is not registered`)
      const base = git(repo, ['cat-file', '-e', `${run.base_commit}^{commit}`], true)
      if (!base.ok) throw new Error(`run ${run.id} base ${run.base_commit} cannot be resolved`)
      const actualTree = git(repo, ['cat-file', '-t', run.input_tree], true)
      if (!actualTree.ok || actualTree.out !== 'tree') {
        throw new Error(`run ${run.id} reviewed tree ${run.input_tree} cannot be resolved as a tree`)
      }
    }
    const run = runs[0]!
    const repo = projectPath(database, run.repo!)
    return classifyReviewTier({ files: diffNumstat(repo!, run.base_commit!, run.input_tree!) })
  } catch (cause) {
    console.error(`warning: review tier not recorded: ${String((cause as Error)?.message ?? cause)}`)
    return null
  }
}

export const pinRef = (runId: number) => `refs/orch/reviewed/${runId}`

export function storedChangePathSet(runId: number, database: Database): string[] | null {
  const row = database.query(
    `SELECT review.path_set FROM review_lens
       JOIN review ON review.id = review_lens.review_id
      WHERE review_lens.run_id=?`,
  ).get(runId) as { path_set: string | null } | null
  if (!row || row.path_set === null) return null
  const parsed = JSON.parse(row.path_set)
  if (!Array.isArray(parsed) || parsed.some((path) => typeof path !== 'string')) {
    throw new Error('review path_set is not a JSON array of paths')
  }
  return parsed
}

export function measureChangeIdentity(
  repo: string, from: string, to: string,
): { patchId: string; paths: string[]; message: string } | null {
  const paths = git(repo, ['diff', '--name-only', `${from}..${to}`])
  const message = git(repo, ['log', '--format=%B', `${from}..${to}`])
  if (!paths.ok) return null
  let patchId: string
  try {
    patchId = changeIdentity((args, stdin) => git(repo, args, true, stdin), from, to)
  } catch { return null }
  return {
    patchId,
    paths: paths.out ? paths.out.split('\n').sort() : [],
    message: message.ok ? message.out : '',
  }
}

export function git(repo: string, args: string[], _hermetic = false, stdin?: Uint8Array): { ok: boolean; out: string; err: string; stdout: Uint8Array } {
  const p = Bun.spawnSync(['git', ...args], {
    cwd: repo, env: targetGitEnvironment(repo), stdin, stdout: 'pipe', stderr: 'pipe',
  })
  return {
    ok: p.exitCode === 0,
    out: p.stdout.toString().trim(),
    err: p.stderr.toString().trim() || `exit ${p.exitCode}`,
    stdout: p.stdout,
  }
}

export const reviewGit = (repo: string): CoverageGitRunner => (args, stdin) => git(repo, args, true, stdin)

export function projectPath(database: Database, name: string): string | null {
  return (database.query('SELECT path FROM project WHERE name=?').get(name) as
    { path: string } | null)?.path ?? null
}


export function pinReviewedCommits(runs: RunRow[], database: Database): void {
  for (const run of runs) {
    if (!run.head_commit) continue
    const warn = (why: string) => {
      console.error(
        `warning: review run ${run.id} recorded but ${pinRef(run.id)} was not created: ` +
        why,
      )
    }
    try {
      const repo = run.repo ? projectPath(database, run.repo) : null
      if (!repo) {
        warn(`project ${run.repo ?? '(none)'} is not registered`)
        continue
      }
      if (!git(repo, ['cat-file', '-e', `${run.head_commit}^{commit}`]).ok) {
        warn(`commit ${run.head_commit} is missing from ${repo}`)
        continue
      }
      const updated = git(repo, ['update-ref', pinRef(run.id), run.head_commit])
      if (!updated.ok) warn(`git update-ref failed: ${updated.err}`)
    } catch (cause) {
      warn(String((cause as Error)?.message ?? cause))
    }
  }
}


export type ReviewPin = {
  project: string
  runId: number
  reviewId: number
  commit: string
  completed: boolean
  superseded: boolean
  landed: boolean
  deleted: boolean
}


/** Inspect keepalive refs; pruning is an explicit act and never part of cleanup. */
export function reviewPins(prune = false, database: Database = db()): ReviewPin[] {
  if (prune) writableDb()
  const registered = new Map((database.query(
    'SELECT name, path, settings FROM project',
  ).all() as { name: string; path: string; settings: string }[]).map((project) => {
    let settings: Record<string, unknown> = {}
    try { settings = JSON.parse(project.settings) } catch { /* unreadable settings have no trunk */ }
    return [project.name, { path: project.path, settings }] as const
  }))
  const rows = database.query(
    `SELECT run.repo, run.branch, run.id AS run_id, rl.review_id, r.completed_at
       FROM review_lens rl
       JOIN review r ON r.id=rl.review_id
       JOIN run ON run.id=rl.run_id
      WHERE run.head_commit IS NOT NULL
      ORDER BY run.repo, run.id`,
  ).all() as {
    repo: string | null; branch: string | null; run_id: number
    review_id: number; completed_at: string | null
  }[]
  const pins: ReviewPin[] = []
  for (const row of rows) {
    if (!row.repo) continue
    const project = registered.get(row.repo)
    if (!project) continue
    const ref = git(project.path, ['rev-parse', '--verify', pinRef(row.run_id)])
    if (!ref.ok) continue
    const superseded = Boolean(database.query(
      `SELECT 1
         FROM review_lens newer_lens
         JOIN review newer ON newer.id=newer_lens.review_id
         JOIN run newer_run ON newer_run.id=newer_lens.run_id
        WHERE newer.id>? AND newer_run.repo=? AND newer_run.branch IS ?
        LIMIT 1`,
    ).get(row.review_id, row.repo, row.branch))
    const trunk = typeof project.settings.trunk === 'string' ? project.settings.trunk.trim() : ''
    const landed = Boolean(row.branch && trunk &&
      git(project.path, ['show-ref', '--verify', '--quiet', `refs/heads/${row.branch}`]).ok &&
      git(project.path, [
        'merge-base', '--is-ancestor', `refs/heads/${row.branch}`, `refs/heads/${trunk}`,
      ]).ok)
    let deleted = false
    if (prune && row.completed_at !== null && landed) {
      const removal = git(project.path, ['update-ref', '-d', pinRef(row.run_id)])
      if (!removal.ok) throw new Error(`git update-ref -d ${pinRef(row.run_id)} failed: ${removal.err}`)
      deleted = true
    }
    pins.push({
      project: row.repo, runId: row.run_id, reviewId: row.review_id, commit: ref.out,
      completed: row.completed_at !== null, superseded, landed, deleted,
    })
  }
  return pins
}

