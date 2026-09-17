// concern: dispatch-preflight
/**
 * Knows the job catalogue, project register, worktree recipe, and recorded
 * worktree paths. Must not know transports, routing, or contracts.
 */
import { seedGuidance } from './args.ts'
import { realpathOrSpelled } from './checkout-identity.ts'
import { db } from './db.ts'
import { repoRootOf } from './git-environment.ts'
import { job } from './jobs.ts'
import { resolveLens } from './lenses.ts'
import {
  assertMainCheckoutClean,
  assertRegisterBranches,
  projectAt,
  projectByName,
  resolvedWorktreeTool,
  validateStoredProjectSettings,
} from './projects.ts'
import { resolveReviewTarget } from './review-target.ts'
import { resolveBase } from './worktree-caller.ts'
import { createCommandExists, validateSeedWithTool } from './worktree-preflight.ts'
import { createHasPlaceholder } from './worktree-template.ts'

const MAX_DEPTH = 1
export const depth = () => Number(process.env.ORCH_DEPTH ?? 0)

const warnedMainCheckouts = new Set<string>()

function warnMainCheckoutUntracked(path: string, warning: string): void {
  if (warnedMainCheckouts.has(path)) return
  warnedMainCheckouts.add(path)
  console.error(warning)
}

/**
 * Everything knowable BEFORE a row exists, checked where no row exists yet.
 *
 * Shared with `detach()`, which claims its placeholder row before the worker
 * process starts — so a precondition checked only inside `run()` still leaves a
 * row behind, and routing reads it as a failure. That happened twice: a
 * forgotten `--seed` was charged to codex as an implementation it could not
 * manage, and a depth refusal left two `(pending)` rows that later went stale.
 *
 * The rule this restores is already written at the top of `run()`: a run that
 * should not exist should not leave a row behind.
 */
export function preflight(
  jobName: string,
  cwd: string,
  seed?: string,
  key?: string,
  baseRef?: string,
  reusesWorktree = false,
  seedAlreadyValidated = false,
  lens?: string,
  reviewRef?: string,
  carry = false,
  repo?: string,
): string | undefined {
  if (depth() >= MAX_DEPTH) {
    throw new Error(
      `refusing to delegate at depth ${depth()}: this process is itself a delegated agent. ` +
        'Answer the question with the tools you have, or hand it back to the caller.',
    )
  }
  if (!reusesWorktree) {
    const named = repo?.trim() ? projectByName(repo) : projectAt(cwd)
    if (named) {
      const warning = assertMainCheckoutClean(named)
      if (warning) warnMainCheckoutUntracked(named.path, warning)
    }
  }
  const j = job(jobName)
  resolveReviewTarget(jobName, cwd, reviewRef, carry)
  const writesJob = Boolean(j.needs.writesRepo)
  if (j.findings && !lens?.trim()) {
    throw new Error(
      `${jobName} produces review findings and requires a stable lens identity.\n  --lens <id>`,
    )
  }
  if (!j.findings && lens !== undefined) {
    throw new Error('--lens is only valid for jobs whose output is review findings')
  }
  if (lens && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(lens)) {
    throw new Error(`lens "${lens}" must be a lowercase stable id of at most 64 characters`)
  }
  if (lens) {
    resolveLens(lens, repo ?? projectAt(cwd)?.name ?? null)
  }
  const repoRoot = repoRootOf(cwd)
  if (jobName === 'review-lens' && repoRoot === null) {
    throw new Error(
      `a review lens reads a change, and ${cwd} is not inside a git checkout, so there is no change to read.\n` +
        `Run it from the checkout that holds the change.`,
    )
  }
  // The key belongs to the branch of a newly cut worktree. Inline jobs never
  // create that branch, so a project's branch template cannot require a key.
  const cutsWorktree = Boolean(j.needs.readsRepo)
  if (!cutsWorktree) return seed
  if (repoRoot === null) {
    throw new Error(`${jobName} reads a repository and ${cwd} is not a git checkout`)
  }
  if (!writesJob && seed !== undefined) {
    throw new Error('--seed is only valid for writing runs; seeds belong to writing runs')
  }
  // A key is required only when a writing worktree's branch template names it,
  // and a seed belongs only to a writing worktree. Read-only jobs bypass both
  // declarations. A resumed turn works in the tree its parent already has, so
  // demanding either again blocks every ruling.
  if (reusesWorktree) return seed
  const project = projectAt(cwd)
  if (project?.settings.worktree) assertRegisterBranches(project)
  const tool = resolvedWorktreeTool(project)
  if (project) {
    const malformed = validateStoredProjectSettings(project.settings, project.path)
    if (malformed.length) throw new Error(malformed.join('\n'))
  }
  const effectiveSeed = seed
  const keyPattern = tool?.keyPattern ?? '^[A-Z][A-Z0-9]+-[0-9]+$'
  const problems: string[] = []
  if (key && !new RegExp(keyPattern).test(key)) {
    problems.push(`key "${key}" does not match ${keyPattern}`)
  }
  if (writesJob && tool?.create && !tool.branch) {
    problems.push(
      `this project's worktree create command has no branch template.\n` +
        `Set the worktree branch key with:\n` +
        `  orch project set ${project!.name} --settings '{"worktree":{"branch":"<template>"}}'`,
    )
  }
  if (writesJob && tool?.branch?.includes('{key}') && !key) {
    problems.push(
      `this project's branch names must carry a ticket key (${tool.branch}), and orch will ` +
        `not invent one.\n  --key <KEY-123>`,
    )
  }
  if (writesJob && tool?.seeds?.length && !effectiveSeed) {
    problems.push(
      `this project requires a database size for a new worktree, and has no default.\n` +
        `${seedGuidance(tool.seeds)}\n\n` +
        `Choosing is the architect's call: it depends on what the task touches.`,
    )
  } else if (writesJob && createHasPlaceholder(tool?.create, 'seed') && !effectiveSeed) {
    problems.push(
      `this project's worktree create arguments contain {seed}, so a seed is required.\n` +
        `  --seed <value>`,
    )
  }
  if (problems.length) throw new Error(problems.join('\n'))
  const selectedCreate = writesJob ? tool?.create : tool?.readonly_create
  if (project && selectedCreate && !createCommandExists(selectedCreate, project.path)) {
    const command =
      typeof selectedCreate === 'object' && 'command' in selectedCreate
        ? selectedCreate.command
        : 'sh'
    throw new Error(
      `project ${project.name} worktree create command ${command} is absent or not executable`,
    )
  }
  if (writesJob && tool?.create && !seedAlreadyValidated) validateSeedWithTool(cwd, effectiveSeed)
  return effectiveSeed
}

/**
 * Chain roots, not rows: every turn of a resumed chain records the same
 * worktree (eleven rows for one tree in the live store), and the exemption
 * asks whether ONE chain owns the tree.
 */
export function recordedChainRootsForWorktree(path: string): number[] {
  const real = realpathOrSpelled(path)
  const rows =
    real === path
      ? (db()
          .query('SELECT COALESCE(parent_run_id, id) AS root FROM run WHERE worktree = ?')
          .all(path) as { root: number }[])
      : (db()
          .query(
            'SELECT COALESCE(parent_run_id, id) AS root FROM run WHERE worktree = ? OR worktree = ?',
          )
          .all(path, real) as { root: number }[])
  return [...new Set(rows.map((row) => row.root))]
}

/**
 * The caller-at-trunk exemption is granted from explicit resume identity only:
 * the chain being resumed, or a --base / --cwd that resolves to exactly one
 * recorded run's worktree path or branch tip. Equality is realpath or commit,
 * never a suffix, and never a table scan (DEV-318).
 */
export function namesRecordedRunTree(opts: {
  cwd: string
  explicitCwd?: boolean
  base?: string
  resume?: { parent: number; worktree: { path: string } | null }
}): boolean {
  if (opts.resume) {
    const row = db().query('SELECT worktree FROM run WHERE id = ?').get(opts.resume.parent) as {
      worktree: string | null
    } | null
    const recorded = row?.worktree ?? opts.resume.worktree?.path
    if (!recorded) return false
    return realpathOrSpelled(recorded) === realpathOrSpelled(opts.cwd)
  }
  if (opts.explicitCwd) return recordedChainRootsForWorktree(opts.cwd).length === 1
  if (!opts.base) return false
  const roots = new Set(
    (
      db()
        .query('SELECT COALESCE(parent_run_id, id) AS root FROM run WHERE branch = ?')
        .all(opts.base) as { root: number }[]
    ).map((row) => row.root),
  )
  try {
    const oid = resolveBase(opts.cwd, opts.base)
    const byCommit = db()
      .query('SELECT COALESCE(parent_run_id, id) AS root FROM run WHERE head_commit = ?')
      .all(oid) as { root: number }[]
    for (const row of byCommit) roots.add(row.root)
  } catch {
    /* --base is not a commit here */
  }
  return roots.size === 1
}
