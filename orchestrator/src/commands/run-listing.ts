// concern: cli
/** Registers run detail and listing adapters. Must not own run behavior. */
import type { Command } from 'commander'
import { db } from '../db.ts'
import { job } from '../jobs.ts'
import { thinOutputWarning } from '../collect.ts'
import { runListingCommand } from '../run-listing.ts'
import { booleanOptions, cliFlags, duration, log, rawArgv, valueOptions } from './support.ts'

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
  booleanOptions(program.command('run <run-id>'), ['receipt']).action(async (id, _options, command) => {
    const { runDetail } = await import('../serve.ts')
    const detail = runDetail(Number(id), cliFlags(rawArgv(command)).has('receipt'))
    if (!detail) throw new Error(`no run ${Number(id)}`)
    log(JSON.stringify(detail))
  })

  const runs = valueOptions(program.command('runs'), ['id', 'job', 'agent', 'limit', 'since'])
  runs.option('--json [version]').option('--unscored').action(async (_options, command) => {
    const argv = rawArgv(command); const flags = cliFlags(argv)
    await runListingCommand({ jsonV1: argv.includes('--json=v1') }, flags, {
      log, dur: duration, chainIsStranded: chainHasPendingDelivery, strandedRecovery,
      thinOutputWarning: (row) => thinOutputWarning({ ...row, writesRepo: Boolean(job(row.job).needs.writesRepo) }),
    })
  })
}
