// concern: test-substance-cli
/** Owns only the `orch test-substance` grammar and presentation. */

import type { Command } from 'commander'
import { testSubstanceJudgeCommand } from '../test-substance/test-substance-commands.ts'
import { write } from './support.ts'

export function register(program: Command): void {
  program
    .command('test-substance')
    .command('judge')
    .option('--tool-input')
    .action(async (options) => {
      const result = await testSubstanceJudgeCommand(
        await Bun.stdin.text(),
        Boolean(options.toolInput),
      )
      write(`${JSON.stringify(result)}\n`)
    })
}
