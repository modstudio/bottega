// concern: cli
/** Registers health reporting adapters. Must not own their behavior. */
import type { Command } from 'commander'
import { doctorCommand } from '../doctor.ts'
import { reclassifyFailuresCommand } from '../failure/failure-commands.ts'
import { blockersCommand, healthCommand } from '../health-commands.ts'
import { JOBS } from '../jobs.ts'
import { candidates, pick } from '../route.ts'
import { acpRuntimeGaps } from '../transport/transport.ts'
import { log, optionFlags } from './support.ts'

export function register(program: Command): void {
  program
    .command('blockers')
    .option('--days <value>')
    .option('--json')
    .allowExcessArguments(false)
    .action((options) => blockersCommand(optionFlags(options), { log }))

  program
    .command('health')
    .option('--days <value>')
    .option('--json')
    .allowExcessArguments(false)
    .action((options) => healthCommand(optionFlags(options), { log }))

  program
    .command('reclassify-failures')
    .option('--dry-run')
    .allowExcessArguments(false)
    .action((options) => {
      reclassifyFailuresCommand(optionFlags(options), { log })
    })

  program
    .command('doctor')
    .option('--wake')
    .allowExcessArguments(false)
    .action(async (options) => {
      await doctorCommand(optionFlags(options), {
        log,
        exitCode: (code) => {
          process.exitCode = code
        },
        candidates,
        pick,
        jobs: () => Object.keys(JOBS),
        acpRuntimeGaps,
      })
    })
}
