// concern: cli
/** Registers read-only setup inspection adapters. Must not own their behavior. */
import type { Command } from 'commander'
import { gatherSetupFacts } from '../setup/setup-facts.ts'
import { log } from './support.ts'

export function register(program: Command): void {
  const setup = program.command('setup')
  setup
    .command('facts')
    .requiredOption('--json')
    .allowExcessArguments(false)
    .action(async () => log(JSON.stringify(await gatherSetupFacts())))
}
