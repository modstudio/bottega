// concern: cli
/** Registers inbox and diff adapters. Must not own their behavior. */
import { existsSync } from 'node:fs'
import type { Command } from 'commander'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { cleanupRepoRoot } from '../cleanup/cleanup.ts'
import { db, sessionId } from '../database/db.ts'
import { JOBS } from '../jobs/jobs.ts'
import { withWorktreeLease } from '../project/project-lock.ts'
import { latestArchitectRead } from '../review/review-read.ts'
import { commitAt, commitsBetween, isAncestor, runDiffCommand } from '../run/run-diff.ts'
import { resolveRunIdentifier } from '../run/run-identifier.ts'
import { runInboxCommand } from '../run/run-inbox.ts'
import { observedChangesIn } from '../worktree/worktree-remove.ts'
import { duration, log, optionFlags, write } from './support.ts'

function chainHasPendingDelivery(rootId: number): boolean {
  return Boolean(
    db()
      .query(
        `SELECT 1 FROM question q JOIN run owner ON owner.id=q.run_id
      WHERE (owner.id=? OR owner.parent_run_id=?)
        AND q.answered_at IS NOT NULL AND q.delivery_pending_at IS NOT NULL LIMIT 1`,
      )
      .get(rootId, rootId),
  )
}

const strandedRecovery = (id: number) =>
  `stranded — ${PLATFORM_SLUG} run retry ${id} --agent … with the recorded ruling, or ${PLATFORM_SLUG} run abandon ${id}`

export function register(program: Command): void {
  program
    .command('inbox')
    .description('list worker and workflow questions needing rulings')
    .option('--all', 'include questions outside your session or project')
    .option('--active', 'include only unanswered questions on live work')
    .option('--cwd <path>', 'scope questions to the project at this path')
    .option('--json', 'write the question inbox as JSON')
    .allowExcessArguments(false)
    .action(async (options) => {
      await runInboxCommand(
        optionFlags(options),
        {
          log,
          dur: duration,
          chainHasPendingDelivery,
          strandedRecovery,
        },
        options.cwd,
      )
    })

  program
    .command('diff <id>')
    .description('show the repository changes produced by a run')
    .option('--quiet', 'suppress the diff header')
    .option('--since-base', 'compare the worktree with the run base')
    .option('--since-read', 'show changes since the latest architect read')
    .allowExcessArguments(false)
    .action(async (id, options) => {
      const runId = resolveRunIdentifier(db(), id)
      await runDiffCommand(runId, optionFlags(options), {
        error: console.error,
        write,
        usage: (): never => {
          throw new Error(`${PLATFORM_SLUG} run diff <id> [--quiet] [--since-base | --since-read]`)
        },
        cleanupRepoRoot,
        observedChangesIn,
        latestArchitectRead: (project, branch) => latestArchitectRead(db(), project, branch),
        commitAt,
        isAncestor,
        commitsBetween,
        exists: existsSync,
        withWorktreeLease: (repoRoot, worktreePath, action) =>
          withWorktreeLease(
            repoRoot,
            worktreePath,
            { session: sessionId(), what: `diff ${runId}` },
            action,
          ),
        writesRepo: (jobName) => Boolean(JOBS[jobName]?.needs.writesRepo),
      })
    })
}
