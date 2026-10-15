import type { Command } from 'commander'
import { db } from '../database/db.ts'
import { resolveRunIdentifier } from '../run/run-identifier.ts'
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
  const claim = board.command('claim').description('manage claims on shared work')
  claim
    .command('take <subject>')
    .description('claim a task, path, or resource')
    .option('--for <duration>', 'set how long the claim remains live')
    .option('--run <id>', 'associate the claim with this run')
    .option('--note <text>', 'record context for the claim')
    .option('--project <name>', 'claim the subject in this project')
    .option('--force', 'supersede a conflicting live claim')
    .action(async (subject, options) =>
      console.log(
        JSON.stringify(
          await boardClaimTake({
            subject,
            durationMs: options.for ? parseDuration(options.for) : undefined,
            runId: options.run === undefined ? undefined : resolveRunIdentifier(db(), options.run),
            note: options.note,
            project: options.project,
            force: Boolean(options.force),
          }),
        ),
      ),
    )
  claim
    .command('renew <id>')
    .description('extend a live claim')
    .action(async (id) => console.log(JSON.stringify(await boardClaimRenew(String(id)))))
  claim
    .command('release <id>')
    .description('release a claim')
    .action(async (id) => console.log(JSON.stringify(await boardClaimRelease(String(id)))))
  claim
    .command('list')
    .description('list board claims')
    .option('--project <name>', 'limit claims to this project')
    .option('--all', 'include claims that are not live')
    .action(async (options) =>
      console.log(JSON.stringify(await boardClaimList(options.project, Boolean(options.all)))),
    )
  claim
    .command('release-task <key>')
    .description('release every live claim for a task')
    .requiredOption('--project <name>', 'name the task project')
    .requiredOption('--json', 'write the released claims as JSON')
    .action(async (key, options) =>
      console.log(JSON.stringify(await boardClaimReleaseTask(key, options.project))),
    )
}
