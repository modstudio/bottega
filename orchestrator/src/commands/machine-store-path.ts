// concern: cli
/** Adapts the hidden, store-free machine store-path probe. */

import type { Command } from 'commander'
import {
  resolveHubDatabase,
  resolveOrchestratorDatabase,
  type StateEnvironment,
} from '../../../shared/state-directory.ts'

export type MachineStorePathPresentation = { write(value: string): void }

/** Print the resolved store path without opening or creating it. */
export function machineStorePathCommand(
  presentation: MachineStorePathPresentation,
  environment: StateEnvironment = process.env,
): void {
  presentation.write(`${resolveOrchestratorDatabase(environment)}\n`)
  presentation.write(`${resolveHubDatabase(environment)}\n`)
}

export function registerMachineStorePathCommand(
  program: Command,
  presentation: MachineStorePathPresentation,
): void {
  program
    .command('store-path', { hidden: true })
    .allowExcessArguments(false)
    .action(() => machineStorePathCommand(presentation))
}
