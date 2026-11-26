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
    .command('post-update <path-kind> [checkout-path] [branch] [before-pull]', { hidden: true })
    .allowExcessArguments(false)
    .action(
      async (
        pathKind: string,
        checkoutPath: string | undefined,
        branch: string | undefined,
        beforePull: string | undefined,
      ) => {
        const postUpdate = await import('../database/post-update-steps.ts')
        if (pathKind === 'distribution') {
          if (checkoutPath || branch || beforePull) {
            throw new Error('machine post-update distribution takes no checkout arguments')
          }
          return postUpdate.postUpdateCommand(presentation, { path: 'distribution' })
        }
        if (pathKind !== 'checkout') {
          throw new Error('machine post-update path must be checkout or distribution')
        }
        if (!checkoutPath || !branch || !beforePull) {
          throw new Error(
            'machine post-update checkout requires checkout path, branch and pre-pull commit',
          )
        }
        return postUpdate.postUpdateCommand(presentation, {
          path: 'checkout',
          checkout: checkoutPath,
          branch,
          beforePull,
        })
      },
    )
  program
    .command('migrate')
    .description('apply pending orchestrator store migrations')
    .option('--backfill-spec-sha', 'backfill missing run specification hashes')
    .option('--force-in-flight <reason>', 'apply a non-additive migration for this operator reason')
    .option('--from-operator', 'confirm the override came directly from the operator')
    .allowExcessArguments(false)
    .action(async (options) =>
      (await import('../database/database-commands.ts')).migrateCommand(presentation, undefined, {
        forceInFlight: options.forceInFlight,
        fromOperator: Boolean(options.fromOperator),
      }),
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
