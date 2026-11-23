// concern: cli
/** Registers routing report adapters. Must not own routing behavior. */
import type { Command } from 'commander'
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
      const { ensureLocalHealth } = await import('../agent/model-host.ts')
      const { guideCommand } = await import('../route/routing-commands.ts')
      await ensureLocalHealth()
      guideCommand(optionFlags(options), { log, dur: duration })
    })

  program
    .command('stats')
    .description('show routing scores, latency, cost, and agent duels')
    .option('--job <value>', 'show statistics for this job')
    .option('--lens <value>', 'show a findings job in this lens cell')
    .allowExcessArguments(false)
    .action(async (options) => {
      const { statsCommand } = await import('../route/routing-commands.ts')
      const { loadSubscriptionCostContext } = await import('../run/run-subscription-prices.ts')
      return statsCommand(optionFlags(options), {
        log,
        dur: duration,
        subscriptionCost: await loadSubscriptionCostContext(),
      })
    })

  program
    .command('cost-backtest')
    .description('backtest cost-policy variants against historical routing decisions')
    .option('--days <value>', 'number of days to replay', '7')
    .option('--without <agents>', 'comma-separated agents to treat as absent from every decision')
    .option('--json', 'write the report as JSON')
    .allowExcessArguments(false)
    .action(async (options) => {
      const { costBacktestCommand } = await import('../route/routing-commands.ts')
      const { loadSubscriptionCostContext } = await import('../run/run-subscription-prices.ts')
      costBacktestCommand(optionFlags(options), {
        log,
        dur: duration,
        subscriptionCost: await loadSubscriptionCostContext(),
      })
    })

  program
    .command('routing-backtest')
    .description('replay historical routing decisions')
    .option('--job <value>', 'replay decisions for this job')
    .option('--seed <value>', 'reproduce the replay with this random seed')
    .option('--json', 'write the replay as JSON')
    .allowExcessArguments(false)
    .action(async (options) => {
      const { routingBacktestCommand } = await import('../route/routing-commands.ts')
      routingBacktestCommand(optionFlags(options), { log, dur: duration })
    })
}
