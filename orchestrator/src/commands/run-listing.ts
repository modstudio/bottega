// concern: cli
/** Registers run detail and listing adapters. Must not own run behavior. */
import type { Command } from 'commander'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { processStartTime } from '../../../shared/process-identity.ts'
import { thinOutputWarning } from '../collect/collect.ts'
import { db } from '../database/db.ts'
import { sampleProcesses } from '../idle-kill.ts'
import { job } from '../jobs/jobs.ts'
import { resolveRunIdentifier } from '../run/run-identifier.ts'
import { runIdentityMap, runListingCommand } from '../run/run-listing.ts'
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
  `stranded — ${PLATFORM_SLUG} run retry ${id} --agent … with the recorded ruling, or ${PLATFORM_SLUG} run abandon ${id}`

export function register(program: Command): void {
  program
    .command('run-identities')
    .description('list numeric run identities and their durable record ids')
    .option('--json', 'write the identity map as JSON')
    .allowExcessArguments(false)
    .action(() => log(JSON.stringify(runIdentityMap())))

  program
    .command('run <run-id>')
    .description('show the complete record for a run')
    .option('--receipt', 'include the run receipt')
    .allowExcessArguments(false)
    .action(async (id, options) => {
      const { runDetail } = await import('../state/serve.ts')
      const runId = resolveRunIdentifier(db(), id)
      const detail = runDetail(runId, Boolean(options.receipt))
      if (!detail) throw new Error(`no run ${runId}`)
      log(JSON.stringify(detail))
    })

  program
    .command('runs')
    .description('list recorded run conversations')
    .option('--id <value>', 'include this run conversation', collect, [])
    .option('--job <value>', 'limit runs to this job')
    .option('--agent <value>', 'limit runs to this agent')
    .option('--limit <value>', 'limit the number of runs')
    .option('--since <value>', 'include activity since this ISO instant')
    .option('--json [version]', 'write runs as JSON in the selected version')
    .option('--unscored', 'list only runs awaiting a verdict')
    .allowExcessArguments(false)
    .action(async (options) => {
      const flags = optionFlags(options)
      const requested = flags.values('id')
      const resolvedFlags = requested.length
        ? {
            ...flags,
            values: (name: string) =>
              name === 'id'
                ? requested.map((value) => String(resolveRunIdentifier(db(), value)))
                : flags.values(name),
          }
        : flags
      await runListingCommand({ jsonV1: options.json === 'v1' }, resolvedFlags, {
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
