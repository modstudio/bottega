// concern: hub-import-cli
/** Owns only the `bottega gate hub-import` grammar and presentation. */

import type { Command } from 'commander'
import { hubImportJudgeCommand } from '../hub-import-commands.ts'
import { write } from './support.ts'

export function register(program: Command): void {
  program
    .command('hub-import')
    .description('judge whether a proposed hub edit respects import boundaries')
    .command('judge')
    .description('read and judge one proposed hub editor payload from standard input')
    .option('--tool-input', 'read an editor tool payload')
    .action(async () => {
      const result = await hubImportJudgeCommand(await Bun.stdin.text())
      write(`${JSON.stringify(result)}\n`)
    })
}
