// concern: cli
/** Registers inbox and diff adapters. Must not own their behavior. */
import type { Command } from 'commander'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { duration, log, optionFlags, write } from './support.ts'

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
      const [{ db }, { pendingQuestionIds }, { runInboxCommand }] = await Promise.all([
        import('../database/db.ts'),
        import('../run/question-delivery-pending.ts'),
        import('../run/run-inbox.ts'),
      ])
      const chainHasPendingDelivery = (rootId: string): boolean => {
        const runIds = db()
          .query<{ record_id: string }, [string, string]>(
            'SELECT record_id FROM run WHERE record_id=? OR parent_run_record_id=?',
          )
          .all(rootId, rootId)
          .map(({ record_id }) => record_id)
        return pendingQuestionIds(db(), { runIds }).length > 0
      }
      const strandedRecovery = (id: string) => {
        const number = (
          db().query('SELECT number FROM run WHERE record_id=?').get(id) as { number: number }
        ).number
        return `stranded — ${PLATFORM_SLUG} run retry ${number} --agent … with the recorded ruling, or ${PLATFORM_SLUG} run abandon ${number}`
      }
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
      const [fs, cleanup, database, jobs, lock, review, diff, identifier, worktree] =
        await Promise.all([
          import('node:fs'),
          import('../cleanup/cleanup.ts'),
          import('../database/db.ts'),
          import('../jobs/jobs.ts'),
          import('../project/project-lock.ts'),
          import('../review/review-read.ts'),
          import('../run/run-diff.ts'),
          import('../run/run-identifier.ts'),
          import('../worktree/worktree-remove.ts'),
        ])
      const runId = identifier.resolveRunIdentifier(database.db(), id)
      await diff.runDiffCommand(runId, optionFlags(options), {
        error: console.error,
        write,
        usage: (): never => {
          throw new Error(`${PLATFORM_SLUG} run diff <id> [--quiet] [--since-base | --since-read]`)
        },
        cleanupRepoRoot: cleanup.cleanupRepoRoot,
        observedChangesIn: worktree.observedChangesIn,
        latestArchitectRead: (project, branch) =>
          review.latestArchitectRead(database.db(), project, branch),
        commitAt: diff.commitAt,
        isAncestor: diff.isAncestor,
        commitsBetween: diff.commitsBetween,
        exists: fs.existsSync,
        withWorktreeLease: (repoRoot, worktreePath, action) =>
          lock.withWorktreeLease(
            repoRoot,
            worktreePath,
            { session: database.sessionId(), what: `diff ${runId}` },
            action,
          ),
        writesRepo: (jobName) => Boolean(jobs.JOBS[jobName]?.needs.writesRepo),
      })
    })
}
