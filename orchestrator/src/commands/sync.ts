// concern: cli
/** Registers record synchronization. Must not own synchronization behavior. */
import type { Command } from 'commander'
import { syncCommand } from '../record-sync-command.ts'
import { log } from './support.ts'

export function register(program: Command): void {
  program.command('sync').action(() => syncCommand({ log }))
}
