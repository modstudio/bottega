// concern: database command adapters
/** Registers machine database verbs without owning their decisions. */

import type { Command } from 'commander'

export function registerDatabaseCommands(
  program: Command,
  presentation: { log(value: string): void },
): void {
  program
    .command('gate-facts')
    .description('write the branch-stable facts consumed by machine-dependent gate legs')
    .requiredOption('--out <path>', 'write the gate-facts JSON to this path')
    .allowExcessArguments(false)
    .action(async (options) => (await import('../gate/gate-facts.ts')).writeGateFacts(options.out))
  program
    .command('update [version]')
    .description('update the installed release, or update a checkout from its landing branch')
    .allowExcessArguments(false)
    .action(async (version?: string) =>
      (await import('../database/machine-update.ts')).machineUpdateCommand(
        presentation,
        {},
        version,
      ),
    )
  program
    .command('migrate')
    .description('apply pending orchestrator store migrations')
    .option('--backfill-spec-sha', 'backfill missing run specification hashes')
    .option('--force-in-flight <reason>', 'apply a non-additive migration for this operator reason')
    .option('--from-operator', 'confirm the override came directly from the operator')
    .allowExcessArguments(false)
    .action(async (options) =>
      (await import('../database/database-commands.ts')).migrateCommand(
        presentation,
        undefined,
        {
        forceInFlight: options.forceInFlight,
        fromOperator: Boolean(options.fromOperator),
        },
      ),
    )
  program
    .command('reconcile <id>')
    .description('reconcile a completed run with its saved artifacts')
    .allowExcessArguments(false)
    .action(async (id) => {
      const [commands, database, identifier] = await Promise.all([
        import('../database/database-commands.ts'),
        import('../database/db.ts'),
        import('../run/run-identifier.ts'),
      ])
      return commands.reconcileCommand(
        identifier.resolveRunIdentifier(database.db(), id),
        presentation,
      )
    })
}
