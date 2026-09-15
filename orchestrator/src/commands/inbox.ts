// concern: cli
/** Registers inbox and diff adapters. Must not own their behavior. */
import type { Command } from 'commander'
import { cleanupRepoRoot } from '../cleanup.ts'
import { db } from '../db.ts'
import { JOBS } from '../jobs.ts'
import { runDiffCommand } from '../run-diff.ts'
import { runInboxCommand } from '../run-inbox.ts'
import { changesIn } from '../worktree-remove.ts'
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
  `stranded — orch retry ${id} --agent … with the recorded ruling, or orch abandon ${id}`

export function register(program: Command): void {
  program
    .command('inbox')
    .option('--all')
    .option('--json')
    .allowExcessArguments(false)
    .action(async (options) => {
      await runInboxCommand(optionFlags(options), {
        log,
        dur: duration,
        chainHasPendingDelivery,
        strandedRecovery,
      })
    })

  program
    .command('diff <id>')
    .option('--quiet')
    .option('--since-base')
    .allowExcessArguments(false)
    .action(async (id, options) => {
      await runDiffCommand(Number(id), optionFlags(options), {
        error: console.error,
        write,
        usage: (): never => {
          throw new Error('orch diff <id> [--quiet] [--since-base]')
        },
        cleanupRepoRoot,
        changesIn,
        writesRepo: (jobName) => Boolean(JOBS[jobName]?.needs.writesRepo),
      })
    })
}
