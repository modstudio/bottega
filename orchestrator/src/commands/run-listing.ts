// concern: cli
/** Registers run detail and listing adapters. Must not own run behavior. */
import { type Command, Option, type OptionValues } from 'commander'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { repeatable } from '../../../shared/cli-repeat-guard.ts'
import { processStartTime } from '../../../shared/process-identity.ts'
import { collect, duration, log, optionFlags, parseChangedAfter } from './support.ts'

async function listRuns(options: OptionValues): Promise<void> {
  const [database, identifier, listing, delivery, jobs, collectModule, sampler, costs] =
    await Promise.all([
      import('../database/db.ts'),
      import('../run/run-identifier.ts'),
      import('../run/run-listing.ts'),
      import('../run/question-delivery-pending.ts'),
      import('../jobs/jobs.ts'),
      import('../collect/collect.ts'),
      import('../process-resource-sampler.ts'),
      import('../run/run-subscription-prices.ts'),
    ])
  const local = database.db()
  const chainHasPendingDelivery = (rootId: string): boolean => {
    const runIds = local
      .query<{ record_id: string }, [string, string]>(
        'SELECT record_id FROM run WHERE record_id=? OR parent_run_record_id=?',
      )
      .all(rootId, rootId)
      .map(({ record_id }) => record_id)
    return delivery.pendingQuestionIds(local, { runIds }).length > 0
  }
  const strandedRecovery = (id: string): string => {
    const number = (
      local.query('SELECT number FROM run WHERE record_id=?').get(id) as { number: number }
    ).number
    return `stranded — ${PLATFORM_SLUG} run retry ${number} --agent … with the recorded ruling, or ${PLATFORM_SLUG} run abandon ${number}`
  }
  const flags = optionFlags(options)
  const requested = flags.values('id')
  const resolvedFlags = requested.length
    ? {
        ...flags,
        values: (name: string) =>
          name === 'id'
            ? requested.map((value) => {
                const parsed = identifier.classifyRunIdentifier(value)
                if (!parsed) return value
                if (parsed.kind === 'record-id') return parsed.recordId
                return identifier.resolveRunIdentifierOrNull(local, parsed.number) ?? value
              })
            : flags.values(name),
      }
    : flags
  const json = resolvedFlags.has('json') || options.json === 'v1'
  const jsonV1 = options.json === 'v1'
  const changedAfter = parseChangedAfter({
    value: resolvedFlags.flag('changed-after'),
    since: resolvedFlags.flag('since'),
    hasRequestedRuns: requested.length > 0,
    json,
    jsonV1,
    limit: resolvedFlags.flag('limit'),
    job: resolvedFlags.flag('job'),
    agent: resolvedFlags.flag('agent'),
    live: resolvedFlags.has('live'),
    unscored: resolvedFlags.has('unscored'),
  })
  await listing.runListingCommand({ jsonV1, changedAfter }, resolvedFlags, {
    log,
    dur: duration,
    chainIsStranded: chainHasPendingDelivery,
    strandedRecovery,
    thinOutputWarning: (row) => {
      const recordedJob = jobs.resolveRecordedRunJob(row)
      return !recordedJob.declared && !recordedJob.writesRepo
        ? null
        : collectModule.thinOutputWarning({ ...row, writesRepo: recordedJob.writesRepo })
    },
    processObservation: { sampleProcesses: sampler.sampleProcesses, processStartTime },
    clock: Date.now,
    subscriptionCost: json ? await costs.loadSubscriptionCostContext() : undefined,
  })
}

export function register(program: Command): void {
  program
    .command('run-identities')
    .description('print numeric run identities and their durable record ids as JSON')
    .allowExcessArguments(false)
    .action(async () =>
      log(JSON.stringify((await import('../run/run-listing.ts')).runIdentityMap())),
    )

  program
    .command('run <run-id>')
    .description('show the complete record for a run')
    .option('--receipt', 'include the run receipt')
    .allowExcessArguments(false)
    .action(async (id, options) => {
      const [state, database, identifier, costs] = await Promise.all([
        import('../state/serve.ts'),
        import('../database/db.ts'),
        import('../run/run-identifier.ts'),
        import('../run/run-subscription-prices.ts'),
      ])
      const runId = identifier.resolveRunIdentifier(database.db(), id)
      const detail = await state.runDetail(runId, Boolean(options.receipt), {
        subscriptionCost: await costs.loadSubscriptionCostContext(),
      })
      if (!detail) throw new Error(`no run ${runId}`)
      log(JSON.stringify(detail))
    })

  program
    .command('runs')
    .description('list recorded run conversations')
    .addOption(
      repeatable(
        new Option('--id <value>', 'include this run conversation').argParser(collect).default([]),
      ),
    )
    .option('--job <value>', 'limit runs to this job')
    .option('--agent <value>', 'limit runs to this agent')
    .option('--limit <value>', 'limit the number of runs')
    .option('--since <value>', 'include activity since this ISO instant')
    .option('--changed-after <sequence>', 'include source rows changed after this cursor')
    .option('--live', 'list only conversations whose latest turn is live')
    .option('--json [version]', 'write runs as JSON in the selected version')
    .option('--unscored', 'list only runs awaiting a verdict')
    .allowExcessArguments(false)
    .action(listRuns)
}
