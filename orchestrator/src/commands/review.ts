// concern: cli
/** Registers review and confinement adapters. Must not own their behavior. */
import type { Command } from 'commander'
import { clearConfinement } from '../confinement-ruling.ts'
import { reviewCommand } from '../review-commands.ts'
import { booleanOptions, cliFlags, rawArgv, valueOptions } from './support.ts'

export function register(program: Command): void {
  const review = valueOptions(program.command('review [args...]'), ['project', 'since', 'task', 'key', 'lens', 'agent', 'category', 'severity'])
  booleanOptions(review, ['open', 'complete', 'json', 'prune']).action(async (_args, _options, command) => {
    const argv = rawArgv(command)
    await reviewCommand(argv[1], argv, cliFlags(argv), {
      log: console.log,
      usage: (): never => { throw new Error('orch review --help') },
    })
  })

  const confinement = valueOptions(program.command('confinement [args...]'), ['writer', 'note', 'tip'])
  confinement.action((_args, _options, command) => {
    const argv = rawArgv(command); const flags = cliFlags(argv)
    const usage = 'orch confinement clear <run-id> --writer <text> --note <text> [--tip <current-tip>]'
    if (argv[1] !== 'clear') throw new Error(usage)
    const id = Number(argv[2]); const writer = flags.flag('writer')?.trim(); const note = flags.flag('note')?.trim()
    if (!id || !writer || !note) throw new Error(usage)
    clearConfinement(id, { writer, note, tip: flags.flag('tip')?.trim() ?? null }, { log: console.log })
  })
}
