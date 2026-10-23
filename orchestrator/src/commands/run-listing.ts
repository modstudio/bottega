// concern: cli
/** Registers run detail and listing adapters. Must not own run behavior. */
import type { Command } from 'commander'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { processStartTime } from '../../../shared/process-identity.ts'
import { thinOutputWarning } from '../collect/collect.ts'
import { db } from '../database/db.ts'
import { resolveRecordedRunJob } from '../jobs/jobs.ts'
import { sampleProcesses } from '../process-resource-sampler.ts'
import {
  classifyRunIdentifier,
  resolveRunIdentifier,
  resolveRunIdentifierOrNull,
} from '../run/run-identifier.ts'
import { runIdentityMap, runListingCommand } from '../run/run-listing.ts'
import { loadSubscriptionCostContext } from '../run/run-subscription-prices.ts'
import { collect, duration, log, optionFlags } from './support.ts'

function chainHasPendingDelivery(rootId: string): boolean {
  return Boolean(
    db()
      .query(
        `SELECT 1 FROM question q JOIN run owner ON owner.record_id=q.run_record_id
      WHERE (owner.record_id=? OR owner.parent_run_record_id=?)
        AND q.answered_at IS NOT NULL AND q.delivery_pending_at IS NOT NULL LIMIT 1`,
      )
      .get(rootId, rootId),
  )
}

const strandedRecovery = (id: string) => {
  const number = (
    db().query('SELECT number FROM run WHERE record_id=?').get(id) as { number: number }
  ).number
  return `stranded — ${PLATFORM_SLUG} run retry ${number} --agent … with the recorded ruling, or ${PLATFORM_SLUG} run abandon ${number}`
}

export function register(program: Command): void {
  program
    .command('run-identities')
    .description('print numeric run identities and their durable record ids as JSON')
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
      const detail = runDetail(runId, Boolean(options.receipt), {
        subscriptionCost: await loadSubscriptionCostContext(),
      })
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
    .option('--live', 'list only conversations whose latest turn is live')
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
                ? requested.map((value) => {
                    const parsed = classifyRunIdentifier(value)
                    if (!parsed) return value
                    if (parsed.kind === 'record-id') return parsed.recordId
                    return resolveRunIdentifierOrNull(db(), parsed.number) ?? value
                  })
                : flags.values(name),
          }
        : flags
      const json = resolvedFlags.has('json') || options.json === 'v1'
      await runListingCommand({ jsonV1: options.json === 'v1' }, resolvedFlags, {
        log,
        dur: duration,
        chainIsStranded: chainHasPendingDelivery,
        strandedRecovery,
        thinOutputWarning: (row) => {
          const recordedJob = resolveRecordedRunJob(row)
          return !recordedJob.declared && !recordedJob.writesRepo
            ? null
            : thinOutputWarning({
                ...row,
                writesRepo: recordedJob.writesRepo,
              })
        },
        processObservation: { sampleProcesses, processStartTime },
        clock: Date.now,
        subscriptionCost: json ? await loadSubscriptionCostContext() : undefined,
      })
    })
}
