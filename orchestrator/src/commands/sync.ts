// concern: cli
/** Registers record synchronization. Must not own synchronization behavior. */
import type { Command } from 'commander'
import { log } from './support.ts'

export function register(program: Command): void {
  program
    .command('sync')
    .description('push pending orchestrator records to the hosted record')
    .option('--backfill', 'enqueue older records before pushing')
    .allowExcessArguments(false)
    .action(async (options) =>
      (await import('../record/record-sync-command.ts')).syncCommand(
        { backfill: Boolean(options.backfill) },
        { log },
      ),
    )
}
