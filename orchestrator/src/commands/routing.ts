// concern: cli
/** Registers routing report adapters. Must not own routing behavior. */
import type { Command } from 'commander'
import { ensureLocalHealth } from '../agents.ts'
import { guideCommand, routingBacktestCommand, statsCommand } from '../routing-commands.ts'
import { booleanOptions, cliFlags, duration, log, rawArgv, valueOptions } from './support.ts'

export function register(program: Command): void {
  const guide = valueOptions(program.command('guide'), ['job', 'prompt-bytes', 'lens'])
  guide.action(async (_options, command) => {
    await ensureLocalHealth()
    guideCommand(cliFlags(rawArgv(command)), { log, dur: duration })
  })

  const stats = valueOptions(program.command('stats'), ['job'])
  stats.action((_options, command) => statsCommand(cliFlags(rawArgv(command)), { log, dur: duration }))

  const backtest = valueOptions(program.command('routing-backtest'), ['job', 'seed'])
  booleanOptions(backtest, ['json']).action((_options, command) => {
    routingBacktestCommand(cliFlags(rawArgv(command)), { log, dur: duration })
  })
}
