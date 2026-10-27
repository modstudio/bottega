// concern: cli
/** Registers routing report adapters. Must not own routing behavior. */
import type { Command } from 'commander'
import { ensureLocalHealth } from '../agent/model-host.ts'
import { guideCommand, routingBacktestCommand, statsCommand } from '../route/routing-commands.ts'
import { loadSubscriptionCostContext } from '../run/run-subscription-prices.ts'
import { duration, log, optionFlags } from './support.ts'

export function register(program: Command): void {
  program
    .command('guide')
    .description('show routing quality and turnaround guidance')
    .option('--job <value>', 'show guidance for this job')
    .option('--prompt-bytes <value>', 'use this prompt size for routing guidance')
    .option('--lens <value>', 'show guidance for this review lens')
    .allowExcessArguments(false)
    .action(async (options) => {
      await ensureLocalHealth()
      guideCommand(optionFlags(options), { log, dur: duration })
    })

  program
    .command('stats')
    .description('show routing scores, latency, cost, and agent duels')
    .option('--job <value>', 'show statistics for this job')
    .allowExcessArguments(false)
    .action(async (options) =>
      statsCommand(optionFlags(options), {
        log,
        dur: duration,
        subscriptionCost: await loadSubscriptionCostContext(),
      }),
    )

  program
    .command('routing-backtest')
    .description('replay historical routing decisions')
    .option('--job <value>', 'replay decisions for this job')
    .option('--seed <value>', 'reproduce the replay with this random seed')
    .option('--json', 'write the replay as JSON')
    .allowExcessArguments(false)
    .action((options) => {
      routingBacktestCommand(optionFlags(options), { log, dur: duration })
    })
}
