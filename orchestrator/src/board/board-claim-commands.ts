import type { Command } from 'commander'
import {
  boardClaimList,
  boardClaimRelease,
  boardClaimReleaseTask,
  boardClaimRenew,
  boardClaimTake,
} from './board-operations.ts'

export function registerBoardClaimCommands(
  board: Command,
  parseDuration: (value: string) => number,
): void {
  const claim = board.command('claim')
  claim
    .command('take <subject>')
    .option('--for <duration>')
    .option('--run <id>')
    .option('--note <text>')
    .option('--project <name>')
    .option('--force')
    .action(async (subject, options) =>
      console.log(
        JSON.stringify(
          await boardClaimTake({
            subject,
            durationMs: options.for ? parseDuration(options.for) : undefined,
            runId: options.run === undefined ? undefined : Number(options.run),
            note: options.note,
            project: options.project,
            force: Boolean(options.force),
          }),
        ),
      ),
    )
  claim
    .command('renew <id>')
    .action(async (id) => console.log(JSON.stringify(await boardClaimRenew(String(id)))))
  claim
    .command('release <id>')
    .action(async (id) => console.log(JSON.stringify(await boardClaimRelease(String(id)))))
  claim
    .command('list')
    .option('--project <name>')
    .option('--all')
    .action(async (options) =>
      console.log(JSON.stringify(await boardClaimList(options.project, Boolean(options.all)))),
    )
  claim
    .command('release-task <key>')
    .requiredOption('--project <name>')
    .requiredOption('--json')
    .action(async (key, options) =>
      console.log(JSON.stringify(await boardClaimReleaseTask(key, options.project))),
    )
}
