// concern: cli
/** Registers routing report adapters. Must not own routing behavior. */
import type { Command } from 'commander'
import { ensureLocalHealth } from '../local-host.ts'
import { guideCommand, routingBacktestCommand, statsCommand } from '../routing-commands.ts'
import { duration, log, optionFlags } from './support.ts'

export function register(program: Command): void {
  program
    .command('guide')
    .option('--job <value>')
    .option('--prompt-bytes <value>')
    .option('--lens <value>')
    .allowExcessArguments(false)
    .action(async (options) => {
      await ensureLocalHealth()
      guideCommand(optionFlags(options), { log, dur: duration })
    })

  program
    .command('stats')
    .option('--job <value>')
    .allowExcessArguments(false)
    .action((options) => statsCommand(optionFlags(options), { log, dur: duration }))

  program
    .command('routing-backtest')
    .option('--job <value>')
    .option('--seed <value>')
    .option('--json')
    .allowExcessArguments(false)
    .action((options) => {
      routingBacktestCommand(optionFlags(options), { log, dur: duration })
    })
}
