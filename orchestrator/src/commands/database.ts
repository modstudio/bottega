// concern: database command adapters
/** Registers machine database verbs without owning their decisions. */

import type { Command } from 'commander'
import { migrateCommand, reconcileCommand } from '../database/database-commands.ts'
import { db } from '../database/db.ts'
import { machineUpdateCommand } from '../database/machine-update.ts'
import { resolveRunIdentifier } from '../run/run-identifier.ts'

export function registerDatabaseCommands(
  program: Command,
  presentation: { log(value: string): void },
): void {
  program
    .command('update')
    .description('fetch, drain when required, and update the registered main checkout')
    .allowExcessArguments(false)
    .action(() => machineUpdateCommand(presentation))
  program
    .command('migrate')
    .description('apply pending orchestrator store migrations')
    .option('--backfill-spec-sha', 'backfill missing run specification hashes')
    .option('--force-in-flight <reason>', 'apply a non-additive migration for this operator reason')
    .option('--from-operator', 'confirm the override came directly from the operator')
    .allowExcessArguments(false)
    .action((options) =>
      migrateCommand(presentation, undefined, {
        forceInFlight: options.forceInFlight,
        fromOperator: Boolean(options.fromOperator),
      }),
    )
  program
    .command('reconcile <id>')
    .description('reconcile a completed run with its saved artifacts')
    .allowExcessArguments(false)
    .action((id) => reconcileCommand(resolveRunIdentifier(db(), id), presentation))
}
