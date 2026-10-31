// concern: host-load command edge
/** Registers host-load CLI flags and delegates validated values to the service. */

import type { Command } from 'commander'
import { db } from '../database/db.ts'
import { hostLoadCommand, sampleHostLoad } from '../host-load-series.ts'
import { writeStdout } from './support.ts'

export function registerHostLoadCommands(program: Command): void {
  const load = program.command('load').description('sample or report machine host load')
  load
    .option('--since <value>', 'report samples since an ISO time or duration (default: 30m)')
    .option('--quantiles <list>', 'comma-separated CPU busy quantiles')
    .option('--json', 'write the host-load report as JSON')
    .allowExcessArguments(false)
    .action((options) =>
      hostLoadCommand(
        db(),
        {
          since: options.since,
          quantiles: options.quantiles,
          json: Boolean(options.json),
        },
        { write: writeStdout },
      ),
    )
  load
    .command('sample')
    .description('append one machine host-load sample')
    .allowExcessArguments(false)
    .action(async () => {
      await sampleHostLoad()
    })
}
