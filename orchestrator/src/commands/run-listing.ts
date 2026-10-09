// concern: cli
/** Registers run detail and listing adapters. Must not own run behavior. */
import type { Command } from 'commander'
import { processStartTime } from '../../../shared/process-identity.ts'
import { thinOutputWarning } from '../collect/collect.ts'
import { db } from '../database/db.ts'
import { sampleProcesses } from '../idle-kill.ts'
import { job } from '../jobs/jobs.ts'
import { runListingCommand } from '../run/run-listing.ts'
import { collect, duration, log, optionFlags } from './support.ts'

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
    .command('run <run-id>')
    .option('--receipt')
    .allowExcessArguments(false)
    .action(async (id, options) => {
      const { runDetail } = await import('../state/serve.ts')
      const detail = runDetail(Number(id), Boolean(options.receipt))
      if (!detail) throw new Error(`no run ${Number(id)}`)
      log(JSON.stringify(detail))
    })

  program
    .command('runs')
    .option('--id <value>', '', collect, [])
    .option('--job <value>')
    .option('--agent <value>')
    .option('--limit <value>')
    .option('--since <value>')
    .option('--json [version]')
    .option('--unscored')
    .allowExcessArguments(false)
    .action(async (options) => {
      const flags = optionFlags(options)
      await runListingCommand({ jsonV1: options.json === 'v1' }, flags, {
        log,
        dur: duration,
        chainIsStranded: chainHasPendingDelivery,
        strandedRecovery,
        thinOutputWarning: (row) =>
          thinOutputWarning({ ...row, writesRepo: Boolean(job(row.job).needs.writesRepo) }),
        processObservation: { sampleProcesses, processStartTime },
        clock: Date.now,
      })
    })
}
