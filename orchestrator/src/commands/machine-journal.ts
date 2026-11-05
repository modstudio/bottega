// concern: cli
/** Adapts the hidden machine journal probe to its store-free service. */

import type { Command } from 'commander'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { installationIdentity } from '../../../shared/install-root.ts'
import { migrationHash, migrationJournal } from '../database/migrations.ts'
import { shapeMachineJournal } from '../machine-journal.ts'

const JSON_ONLY_REFUSAL = `machine journal prints JSON only\ncleared by: ${PLATFORM_SLUG} machine journal --json`

export type MachineJournalPresentation = { write(value: string): void }

/** Print the running install's identity and journal without opening machine state. */
export function machineJournalCommand(
  json: boolean,
  presentation: MachineJournalPresentation,
): void {
  if (!json) throw new Error(JSON_ONLY_REFUSAL)
  const journal = migrationJournal()
  const result = shapeMachineJournal(
    installationIdentity(import.meta.dir, process.env),
    journal.map((entry) => ({ ...entry, hash: migrationHash(entry) })),
  )
  presentation.write(`${JSON.stringify(result)}\n`)
}

export function registerMachineJournalCommand(
  program: Command,
  presentation: MachineJournalPresentation,
): void {
  program
    .command('journal', { hidden: true })
    .option('--json', 'write the install identity and migration journal as JSON')
    .allowExcessArguments(false)
    .action((options) => machineJournalCommand(Boolean(options.json), presentation))
}
