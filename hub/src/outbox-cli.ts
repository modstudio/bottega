import type { Command } from 'commander'
import { requireDatabase } from './db.ts'
import { runHostedOutboxCommand } from './outbox.ts'

function print(argv: string[]): void {
  requireDatabase()
  for (const line of runHostedOutboxCommand(argv)) console.log(line)
}

export function registerOutboxCommands(program: Command): void {
  const outbox = program
    .command('outbox')
    .description('list queued and quarantined hosted writes')
    .option('--json', '')
    .action((options: { json?: boolean }) => print(['outbox', ...(options.json ? ['--json'] : [])]))
  outbox
    .command('trace')
    .description('list non-trivial delivery outcomes, newest first')
    .option('--row <id>', '')
    .option('--json', '')
    .action((options: { row?: string; json?: boolean }) =>
      print([
        'outbox',
        'trace',
        ...(options.row ? ['--row', options.row] : []),
        ...(options.json ? ['--json'] : []),
      ]),
    )
  outbox
    .command('show <id>')
    .description('show an entry and any values kept after a hosted delete')
    .action((id) => print(['outbox', 'show', id]))
  outbox
    .command('retry <id>')
    .description('clear quarantine and queue an entry for retry')
    .action((id) => print(['outbox', 'retry', id]))
  outbox
    .command('discard <id>')
    .description('discard a quarantined entry')
    .action((id) => print(['outbox', 'discard', id]))
}
