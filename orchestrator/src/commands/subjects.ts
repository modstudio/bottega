// concern: cli
/** Registers project-subject commands. Must not own their behavior. */
import type { Command } from 'commander'
import { subjectCommand } from '../subject/subject-commands.ts'
import { log, optionFlags } from './support.ts'

export function register(program: Command): void {
  program
    .command('subject [args...]')
    .option('--definition <value>')
    .option('--retired')
    .option('--json')
    .action(async (args, options) => {
      const argv = ['subject', ...args]
      await subjectCommand(argv[1] ?? 'list', argv, optionFlags(options), { log })
    })
}
