// concern: cli
/** Registers record authentication grammar. Must not own authentication behavior. */
import { createInterface } from 'node:readline/promises'
import type { Command } from 'commander'
import { signInCommand, signUpCommand, whoamiCommand } from '../record-auth-command.ts'
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
  record
    .command('sign-up')
    .requiredOption('--email <email>')
    .requiredOption('--name <name>')
    .action((options) => signUpCommand(String(options.email), String(options.name), promptPassword, { log }))
  record
    .command('sign-in')
    .requiredOption('--email <email>')
    .action((options) => signInCommand(String(options.email), promptPassword, { log }))
  record.command('whoami').action(() => whoamiCommand({ log }))
}
