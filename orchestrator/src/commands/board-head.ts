// concern: board-head-cli
/** Owns only the `bottega gate board-head` grammar and presentation. */

import type { Command } from 'commander'
import { write } from './support.ts'

export function register(program: Command): void {
  program
    .command('board-head')
    .description('judge whether proposed local board SQL has a local-board head')
    .command('judge')
    .description('read and judge one proposed editor payload from standard input')
    .option('--tool-input', 'read an editor tool payload')
    .action(async () => {
      const { boardHeadJudgeCommand } = await import('../board-head-commands.ts')
      write(`${JSON.stringify(boardHeadJudgeCommand(await Bun.stdin.text()))}\n`)
    })
}
