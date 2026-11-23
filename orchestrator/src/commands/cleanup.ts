// concern: cli
/** Registers cleanup adapters. Must not own cleanup decisions. */

import type { Database } from 'bun:sqlite'
import { existsSync, writeFileSync } from 'node:fs'
import type { Command } from 'commander'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { CleanupPresentation } from '../cleanup/cleanup.ts'
import { log, optionFlags } from './support.ts'

function keptBranchLine(
  database: Database,
  branch: string,
  uniqueCount: number,
  afterCutCount: number | null,
  id: string,
): string {
  const number = (
    database.query('SELECT number FROM run WHERE record_id=?').get(id) as { number: number }
  ).number
  const reason =
    afterCutCount === null
      ? `${uniqueCount} commit(s) reachable only from this branch`
      : `deleting it would lose commits reachable from no other ref; ${afterCutCount} commit(s) after the cut`
  return `kept branch ${branch}: ${reason} — merge it, or ${PLATFORM_SLUG} run discard ${number} --force to delete it after checking no other run owns it`
}

const cleanupPresentation = (database: Database): CleanupPresentation => ({
  log,
  error: (...values) => console.error(...values),
  setExitCode: (code) => {
    process.exitCode = code
  },
  keptBranchLine: (...args) => keptBranchLine(database, ...args),
})

function auditReason(flags: ReturnType<typeof optionFlags>): string | null {
  const scorer = flags.flag('scorer')
  if (scorer) return `--scorer ${scorer}`
  if (flags.has('force')) return '--force'
  return flags.flag('unreviewed') ?? flags.flag('note') ?? null
}

function lifecycleCheckpoint(name: string): void {
  if (process.env.BOTTEGA_TEST_LIFECYCLE_CHECKPOINT !== name) return
  const ready = process.env.BOTTEGA_TEST_LIFECYCLE_READY
  const release = process.env.BOTTEGA_TEST_LIFECYCLE_RELEASE
  if (!ready || !release) return
  writeFileSync(ready, `${name}\n`)
  while (!existsSync(release)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
}

export function register(program: Command): void {
  program
    .command('sweep')
    .description('release terminal runs and reclaim safe stale resources')
    .option('--project <value>', 'registered project whose resources are swept')
    .option('--force', 'continue despite a project sweep failure')
    .option('--dry-run', 'report releases without applying them')
    .option('--verbose', 'list every kept run artifact')
    .allowExcessArguments(false)
    .action(async (options) => {
      const [{ sweepRuns }, grokTrust, taskList] = await Promise.all([
        import('../cleanup/cleanup-sweep.ts'),
        import('../sandbox/grok-trust.ts'),
        import('../workflow/project-task-list.ts'),
      ])
      const database = (await import('../database/db.ts')).db()
      const flags = optionFlags(options)
      await sweepRuns(
        {
          dryRun: flags.has('dry-run'),
          verbose: flags.has('verbose'),
          project: flags.flag('project'),
          force: flags.has('force'),
          presentation: cleanupPresentation(database),
        },
        {
          observeGrokTrustHeadings: grokTrust.observeGrokTrustHeadings,
          grokTrustPathFromHeading: grokTrust.grokTrustPathFromHeading,
          hubTaskReader: taskList.readProjectTaskList,
        },
      )
    })

  program
    .command('discard <id>')
    .description('remove a run worktree and discard its branch')
    .option('--force', 'discard a branch with unique commits')
    .allowExcessArguments(false)
    .action(async (id, options) => {
      const [{ discardRun }, databaseModule, identifier] = await Promise.all([
        import('../cleanup/cleanup.ts'),
        import('../database/db.ts'),
        import('../run/run-identifier.ts'),
      ])
      const database = databaseModule.db()
      const flags = optionFlags(options)
      await discardRun(identifier.resolveRunIdentifier(database, id), {
        force: flags.has('force'),
        auditReason: auditReason(flags),
        presentation: cleanupPresentation(database),
      })
    })

  program
    .command('stop <id>')
    .description('stop a live run and its processes')
    .allowExcessArguments(false)
    .action(async (id) => {
      const [{ stopRun }, processModule, sharedGit, databaseModule, identifier] = await Promise.all(
        [
          import('../run/run-stop.ts'),
          import('../run/run-process.ts'),
          import('../run/shared-git-config-run.ts'),
          import('../database/db.ts'),
          import('../run/run-identifier.ts'),
        ],
      )
      const database = databaseModule.db()
      await stopRun(
        identifier.resolveRunIdentifier(database, id),
        { force: false, auditReason: null, presentation: cleanupPresentation(database) },
        {
          lifecycleCheckpoint,
          planRunProcessTermination: processModule.planRecordedRunTermination,
          terminateRunProcesses: processModule.confirmRunProcessTermination,
          checkSharedGitConfig: sharedGit.terminalSharedGitConfigForRecordedRun,
        },
      )
    })

  program
    .command('abandon <id>')
    .description('stop a run and abandon its worktree')
    .option('--note <value>', 'record why the run is abandoned')
    .option('--force', 'abandon a branch with unique commits')
    .allowExcessArguments(false)
    .action(async (id, options) => {
      const [
        { abandonRun },
        { terminalSharedGitConfigForRecordedRun },
        databaseModule,
        identifier,
      ] = await Promise.all([
        import('../run/run-stop.ts'),
        import('../run/shared-git-config-run.ts'),
        import('../database/db.ts'),
        import('../run/run-identifier.ts'),
      ])
      const database = databaseModule.db()
      const flags = optionFlags(options)
      await abandonRun(
        identifier.resolveRunIdentifier(database, id),
        {
          force: flags.has('force'),
          note: flags.flag('note'),
          auditReason: auditReason(flags),
          presentation: cleanupPresentation(database),
        },
        {
          lifecycleCheckpoint,
          checkSharedGitConfig: terminalSharedGitConfigForRecordedRun,
        },
      )
    })
}
