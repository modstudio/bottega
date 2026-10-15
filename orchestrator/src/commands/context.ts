// concern: cli
/** Registers the architect session-context adapter. Must not own resolution. */
import type { Command } from 'commander'
import { sessionContextCommand } from '../workflow/session-context.ts'
import { log } from './support.ts'

export function register(program: Command): void {
  program
    .command('context')
    .description('show the resolved architect context for a checkout')
    .requiredOption('--cwd <path>', 'resolve context for this checkout path')
    .option('--json', 'write the resolved context as JSON')
    .allowExcessArguments(false)
    .action((options) =>
      sessionContextCommand({ cwd: options.cwd, json: Boolean(options.json) }, { log }),
    )
}
