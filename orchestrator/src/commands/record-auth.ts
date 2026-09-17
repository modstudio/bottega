// concern: cli
/** Registers record authentication grammar. Must not own authentication behavior. */
import { createInterface } from 'node:readline/promises'
import type { Command } from 'commander'
import { signInCommand, signUpCommand, whoamiCommand } from '../record-auth-command.ts'
import {
  recordDoctorCommand,
  recordMigrateCommand,
  recordSpaceAcceptCommand,
  recordSpaceInvitationsCommand,
  recordSpaceInviteCommand,
  recordSpaceListCommand,
  recordSpaceSwitchCommand,
} from '../record-command.ts'
import { pushDocsCommand } from '../record-push-docs.ts'
import { log } from './support.ts'

async function promptPassword(): Promise<string> {
  const terminal = createInterface({ input: process.stdin, output: process.stderr })
  try {
    return await terminal.question('Record password: ')
  } finally {
    terminal.close()
  }
}

export function register(program: Command): void {
  const record = program.command('record')
  const presentation = { log }
  record
    .command('sign-up')
    .requiredOption('--email <email>')
    .requiredOption('--name <name>')
    .action((options) =>
      signUpCommand(String(options.email), String(options.name), promptPassword, { log }),
    )
  record
    .command('sign-in')
    .requiredOption('--email <email>')
    .action((options) => signInCommand(String(options.email), promptPassword, { log }))
  record.command('whoami').action(() => whoamiCommand({ log }))
  record.command('migrate').action(() => recordMigrateCommand(presentation))
  const space = record.command('space')
  space.command('list').action(() => recordSpaceListCommand(presentation))
  space
    .command('switch')
    .argument('<slug-or-id>')
    .action((value) => recordSpaceSwitchCommand(String(value), presentation))
  space
    .command('invite')
    .requiredOption('--email <email>')
    .option('--role <role>', 'member or owner', 'member')
    .action((options) =>
      recordSpaceInviteCommand(String(options.email), String(options.role), presentation),
    )
  space.command('invitations').action(() => recordSpaceInvitationsCommand(presentation))
  space
    .command('accept')
    .argument('<invitation-id>')
    .action((value) => recordSpaceAcceptCommand(String(value), presentation))
  record
    .command('push-docs')
    .option('--dry-run')
    .action((options) => pushDocsCommand({ dryRun: Boolean(options.dryRun) }, { log }))
  record.command('doctor').action(() =>
    recordDoctorCommand({
      log,
      exitCode: (code) => {
        process.exitCode = code
      },
    }),
  )
}
