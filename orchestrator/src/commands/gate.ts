// concern: cli
/** Registers gate evidence adapters. Must not own gate policy. */
import type { Command } from 'commander'
import { writableDb } from '../db.ts'
import { flakeCommand } from '../gate-policy.ts'
import { log, rawArgv, valueOptions } from './support.ts'

export function register(program: Command): void {
  const flake = valueOptions(program.command('flake [args...]'), ['load'])
  flake.action((_args, _options, command) => log(flakeCommand(rawArgv(command).slice(1), writableDb())))
}
