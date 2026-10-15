// concern: test-substance-cli
/** Owns only the `bottega gate test-substance` grammar and presentation. */

import type { Command } from 'commander'
import { testSubstanceJudgeCommand } from '../test-substance-commands.ts'
import { write } from './support.ts'

export function register(program: Command): void {
  program
    .command('test-substance')
    .description('judge whether a proposed test edit has substance')
    .command('judge')
    .description('read and judge one proposed test edit from standard input')
    .option('--tool-input', 'read an editor tool payload instead of a direct test edit')
    .action(async (options) => {
      const result = await testSubstanceJudgeCommand(
        await Bun.stdin.text(),
        Boolean(options.toolInput),
      )
      write(`${JSON.stringify(result)}\n`)
    })
}
