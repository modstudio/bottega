// concern: cli
/** Registers health reporting adapters. Must not own their behavior. */
import type { Command } from 'commander'
import { log, optionFlags } from './support.ts'

export function register(program: Command): void {
  program
    .command('blockers')
    .description('rank reported environment blockers by recurrence')
    .option('--days <value>', 'number of recent days to include')
    .option('--json', 'write the blocker report as JSON')
    .allowExcessArguments(false)
    .action(async (options) =>
      (await import('../health/health-commands.ts')).blockersCommand(optionFlags(options), { log }),
    )

  program
    .command('health')
    .description('report harness failures, costs, and false verdicts')
    .option('--days <value>', 'number of recent days to include')
    .option('--json', 'write the health report as JSON')
    .allowExcessArguments(false)
    .action(async (options) =>
      (await import('../health/health-commands.ts')).healthCommand(optionFlags(options), { log }),
    )

  program
    .command('reclassify-failures')
    .description(
      'classify unclassified quota, billing, and authentication failures and Goose provider-error contract rows',
    )
    .option('--dry-run', 'report reclassifications without writing them')
    .allowExcessArguments(false)
    .action(async (options) => {
      const [{ reclassifyFailuresCommand }, { persistedRunOutput }, { rollUpChangedTurnRoots }] =
        await Promise.all([
          import('../failure/failure-commands.ts'),
          import('../collect/collect.ts'),
          import('../run/run-root-rollup.ts'),
        ])
      reclassifyFailuresCommand(
        optionFlags(options),
        { log },
        persistedRunOutput,
        rollUpChangedTurnRoots,
      )
    })

  program
    .command('doctor')
    .description('diagnose orchestrator installation and runtime health')
    .option('--wake', 'wake configured local model services during diagnosis')
    .allowExcessArguments(false)
    .action(async (options) => {
      const [doctor, route, jobs, transport, search] = await Promise.all([
        import('../health/doctor.ts'),
        import('../route/route.ts'),
        import('../jobs/jobs.ts'),
        import('../transport/transport.ts'),
        import('../doc/doc-search.ts'),
      ])
      await doctor.doctorCommand(optionFlags(options), {
        log,
        exitCode: (code) => {
          process.exitCode = code
        },
        candidates: route.candidates,
        pick: route.pick,
        jobs: () => Object.keys(jobs.JOBS),
        acpRuntimeGaps: transport.acpRuntimeGaps,
        retrievalCheck: search.checkRetrieval,
      })
    })
}
