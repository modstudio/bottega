// concern: cli
/** Registers the semantic code-search CLI surface. */

import type { Command } from 'commander'
import { codeSearchCommand } from '../code/code-commands.ts'
import { log, optionFlags } from './support.ts'

export function register(program: Command): void {
  program
    .command('code <subcommand> [query]')
    .option('--project <value>')
    .option('--k <value>')
    .option('--json')
    .action(async (subcommand, query, options) => {
      if (subcommand !== 'search') throw new Error('orch code search "<query>"')
      await codeSearchCommand(query, optionFlags(options), { cwd: process.cwd, log })
    })
}
