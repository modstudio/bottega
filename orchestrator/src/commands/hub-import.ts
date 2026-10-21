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
    .requiredOption('--deadline-ms <epoch-ms>', 'absolute hook deadline in epoch milliseconds')
    .action(async (options: { deadlineMs: string }) => {
      const deadlineMs = Number(options.deadlineMs)
      if (!Number.isFinite(deadlineMs)) throw new Error('--deadline-ms must be a number')
      const result = await hubImportJudgeCommand(await Bun.stdin.text(), deadlineMs)
      write(`${JSON.stringify(result)}\n`)
    })
}
