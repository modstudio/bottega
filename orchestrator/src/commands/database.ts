// concern: database command adapters
/** Registers machine database verbs without owning their decisions. */

import type { Command } from 'commander'
import { MACHINE_UPDATE_LOCK_HELD_ENV, withMachineUpdateLock } from '../../../shared/update-lock.ts'
import { migrateCommand, reconcileCommand } from '../database/database-commands.ts'
import { db } from '../database/db.ts'
import { machineUpdateCommand } from '../database/machine-update.ts'
import { writeGateFacts } from '../gate/gate-facts.ts'
import { resolveRunIdentifier } from '../run/run-identifier.ts'

export function registerDatabaseCommands(
  program: Command,
  presentation: { log(value: string): void },
): void {
  program
    .command('gate-facts')
    .description('write the branch-stable facts consumed by machine-dependent gate legs')
    .requiredOption('--out <path>', 'write the gate-facts JSON to this path')
    .allowExcessArguments(false)
    .action((options) => writeGateFacts(options.out))
  program
    .command('update [version]')
    .description('update the installed release, or update a checkout from its landing branch')
    .allowExcessArguments(false)
    .action((version?: string) => machineUpdateCommand(presentation, {}, version))
  program
    .command('migrate')
    .description('apply pending orchestrator store migrations')
    .option('--backfill-spec-sha', 'backfill missing run specification hashes')
    .option('--force-in-flight <reason>', 'apply a non-additive migration for this operator reason')
    .option('--from-operator', 'confirm the override came directly from the operator')
    .allowExcessArguments(false)
    .action((options) => {
      const migrate = () =>
        migrateCommand(presentation, undefined, {
          forceInFlight: options.forceInFlight,
          fromOperator: Boolean(options.fromOperator),
        })
      return process.env[MACHINE_UPDATE_LOCK_HELD_ENV] === '1'
        ? migrate()
        : withMachineUpdateLock(migrate)
    })
  program
    .command('reconcile <id>')
    .description('reconcile a completed run with its saved artifacts')
    .allowExcessArguments(false)
    .action((id) => reconcileCommand(resolveRunIdentifier(db(), id), presentation))
}
