// concern: cli
/** Registers inbox and diff adapters. Must not own their behavior. */
import type { Command } from 'commander'
import { db } from '../db.ts'
import { JOBS } from '../jobs.ts'
import { cleanupRepoRoot } from '../cleanup.ts'
import { changesIn } from '../worktree.ts'
import { runDiffCommand } from '../run-diff.ts'
import { runInboxCommand } from '../run-inbox.ts'
import { booleanOptions, cliFlags, duration, rawArgv } from './support.ts'

function chainHasPendingDelivery(rootId: number): boolean {
  return Boolean(db().query(
    `SELECT 1 FROM question q JOIN run owner ON owner.id=q.run_id
      WHERE (owner.id=? OR owner.parent_run_id=?)
        AND q.answered_at IS NOT NULL AND q.delivery_pending_at IS NOT NULL LIMIT 1`,
  ).get(rootId, rootId))
}

const strandedRecovery = (id: number) =>
  `stranded — orch retry ${id} --agent … with the recorded ruling, or orch abandon ${id}`

export function register(program: Command): void {
  booleanOptions(program.command('inbox'), ['all', 'json']).action(async (_options, command) => {
    await runInboxCommand(cliFlags(rawArgv(command)), {
      log: console.log, dur: duration, chainHasPendingDelivery, strandedRecovery,
    })
  })

  booleanOptions(program.command('diff <id>'), ['quiet', 'since-base']).action(async (id, _options, command) => {
    await runDiffCommand(Number(id), cliFlags(rawArgv(command)), {
      error: console.error, write: (value) => { process.stdout.write(value) },
      usage: (): never => { throw new Error('orch diff <id> [--quiet] [--since-base]') },
      cleanupRepoRoot, changesIn,
      writesRepo: (jobName) => Boolean(JOBS[jobName]?.needs.writesRepo),
    })
  })
}
