import type { Command } from 'commander'
import {
  listClaims,
  releaseClaim,
  releaseTaskClaims,
  renewClaim,
  takeClaim,
} from './board-claim-service.ts'

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
    .action((subject, options) =>
      console.log(
        JSON.stringify(
          takeClaim({
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
  claim.command('renew <id>').action((id) => console.log(JSON.stringify(renewClaim(Number(id)))))
  claim
    .command('release <id>')
    .action((id) => console.log(JSON.stringify(releaseClaim(Number(id)))))
  claim
    .command('list')
    .option('--project <name>')
    .option('--all')
    .action((options) =>
      console.log(JSON.stringify(listClaims(options.project, Boolean(options.all)))),
    )
  claim
    .command('release-task <key>')
    .requiredOption('--project <name>')
    .requiredOption('--json')
    .action((key, options) => console.log(JSON.stringify(releaseTaskClaims(key, options.project))))
}
