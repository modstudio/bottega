import type { Command } from 'commander'
import { requireDatabase } from './db.ts'
import {
  discardHostedOutboxEntryCommand,
  hostedOutboxLines,
  retryHostedOutboxEntryCommand,
  showHostedOutboxEntry,
} from './outbox.ts'
import { outboxTraceLines } from './outbox-trace.ts'

function print(lines: () => string[]): void {
  requireDatabase()
  for (const line of lines()) console.log(line)
}

export function registerOutboxCommands(program: Command): void {
  const outbox = program
    .command('outbox')
    .description('list queued and quarantined hosted writes')
    .option('--json', '')
    .action((options: { json?: boolean }) => print(() => hostedOutboxLines(options.json)))
  outbox
    .command('trace')
    .description('list non-trivial delivery outcomes, newest first')
    .option('--row <id>', 'outbox row whose delivery outcomes are listed')
    .option('--json', 'write the delivery outcomes as JSON')
    .action((options: { row?: string; json?: boolean }) =>
      print(() => outboxTraceLines(options.row, options.json)),
    )
  outbox
    .command('show <id>')
    .description('show an entry and any values kept after a hosted delete')
    .action((id) => print(() => showHostedOutboxEntry(id)))
  outbox
    .command('retry <id>')
    .description('clear quarantine and queue an entry for retry')
    .action((id) => print(() => retryHostedOutboxEntryCommand(id)))
  outbox
    .command('discard <id>')
    .description('discard a quarantined entry')
    .action((id) => print(() => discardHostedOutboxEntryCommand(id)))
}
