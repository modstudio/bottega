// concern: cli
/** Registers review and confinement adapters. Must not own their behavior. */
import type { Command } from 'commander'
import { clearConfinement } from '../confinement/confinement-ruling.ts'
import { dispatchReviewCommand } from '../review/review-command-dispatcher.ts'
import { log, optionFlags } from './support.ts'

export function register(program: Command): void {
  program
    .command('review [args...]')
    .option('--project <value>')
    .option('--since <value>')
    .option('--task <value>')
    .option('--key <value>')
    .option('--lens <value>')
    .option('--agent <value>')
    .option('--category <value>')
    .option('--severity <value>')
    .option('--reason <value>')
    .option('--sha <value>')
    .option('--note <value>')
    .option('--open')
    .option('--complete')
    .option('--json')
    .option('--dry-run')
    .option('--prune')
    .option('--write')
    .option('--confirm-restore')
    .option('--confirm-live-store <path>')
    .action(async (args, options) => {
      const argv = ['review', ...args]
      await dispatchReviewCommand(argv[1], argv, optionFlags(options), {
        log,
        usage: (): never => {
          throw new Error('orch review --help')
        },
      })
    })

  program
    .command('confinement [args...]')
    .option('--writer <value>')
    .option('--note <value>')
    .option('--tip <value>')
    .action((args, options) => {
      const argv = ['confinement', ...args]
      const flags = optionFlags(options)
      const usage =
        'orch confinement clear <run-id> --writer <text> --note <text> [--tip <current-tip>]'
      if (argv[1] !== 'clear') throw new Error(usage)
      const id = Number(argv[2])
      const writer = flags.flag('writer')?.trim()
      const note = flags.flag('note')?.trim()
      if (!id || !writer || !note) throw new Error(usage)
      clearConfinement(id, { writer, note, tip: flags.flag('tip')?.trim() ?? null }, { log })
    })
}
