// concern: cli
/** Registers the semantic code-search CLI surface. */

import type { Command } from 'commander'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { log, optionFlags } from './support.ts'
export function register(program: Command): void {
  program
    .command('code <subcommand> [query]')
    .description("search a project's code for a query")
    .option('--project <value>', 'select a project')
    .option('--k <value>', 'return this many matching snippets')
    .option('--json', 'write the search results as JSON')
    .action(async (subcommand, query, options) => {
      if (subcommand !== 'search') throw new Error(`${PLATFORM_SLUG} doc code search "<query>"`)
      const { codeSearchCommand } = await import('../code/code-commands.ts')
      await codeSearchCommand(query, optionFlags(options), { cwd: process.cwd, log })
    })
}
