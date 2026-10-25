// concern: cli
/** Registers the run task-linking adapter. Must not own derivation or persistence behavior. */

import type { Command } from 'commander'
import { formatRunTaskLinkReport, linkRunTasks } from '../run/run-task-linking.ts'
import { log, optionFlags } from './support.ts'

export function register(program: Command): void {
  program
    .command('link-tasks')
    .description('derive missing run task and project links from recorded facts')
    .option('--dry-run', 'report links without writing them')
    .option('--json', 'write the report as JSON')
    .allowExcessArguments(false)
    .action(async (options) => {
      const flags = optionFlags(options)
      const report = await linkRunTasks({ dryRun: flags.has('dry-run') })
      if (flags.has('json')) log(JSON.stringify(report))
      else for (const line of formatRunTaskLinkReport(report)) log(line)
    })
}
