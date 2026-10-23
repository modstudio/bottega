// concern: cli
/** Registers cleanup adapters. Must not own cleanup decisions. */

import { existsSync, writeFileSync } from 'node:fs'
import type { Command } from 'commander'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { type CleanupPresentation, discardRun } from '../cleanup/cleanup.ts'
import { sweepRuns } from '../cleanup/cleanup-sweep.ts'
import { db } from '../database/db.ts'
import { JOBS } from '../jobs/jobs.ts'
import { resolveRunIdentifier } from '../run/run-identifier.ts'
import { confirmRunProcessTermination, planRecordedRunTermination } from '../run/run-process.ts'
import { abandonRun, stopRun } from '../run/run-stop.ts'
import { terminalSharedGitConfigForRun } from '../run/shared-git-config.ts'
import { grokTrustPathFromHeading, observeGrokTrustHeadings } from '../sandbox/grok-trust.ts'
import { log, optionFlags } from './support.ts'

function keptBranchLine(
  branch: string,
  uniqueCount: number,
  afterCutCount: number | null,
  id: string,
): string {
  const number = (
    db().query('SELECT number FROM run WHERE record_id=?').get(id) as { number: number }
  ).number
  const reason =
    afterCutCount === null
      ? `${uniqueCount} commit(s) reachable only from this branch`
      : `deleting it would lose commits reachable from no other ref; ${afterCutCount} commit(s) after the cut`
  return `kept branch ${branch}: ${reason} — merge it, or ${PLATFORM_SLUG} run discard ${number} --force to delete it after checking no other run owns it`
}

const presentation: CleanupPresentation = {
  log: log,
  error: (...values) => console.error(...values),
  setExitCode: (code) => {
    process.exitCode = code
  },
  keptBranchLine,
}

function auditReason(flags: ReturnType<typeof optionFlags>): string | null {
  const scorer = flags.flag('scorer')
  if (scorer) return `--scorer ${scorer}`
  if (flags.has('force')) return '--force'
  return flags.flag('unreviewed') ?? flags.flag('note') ?? null
}

function lifecycleCheckpoint(name: string): void {
  if (process.env.ORCH_TEST_LIFECYCLE_CHECKPOINT !== name) return
  const ready = process.env.ORCH_TEST_LIFECYCLE_READY
  const release = process.env.ORCH_TEST_LIFECYCLE_RELEASE
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
      const flags = optionFlags(options)
      await sweepRuns(
        {
          dryRun: flags.has('dry-run'),
          verbose: flags.has('verbose'),
          project: flags.flag('project'),
          force: flags.has('force'),
          presentation,
        },
        { observeGrokTrustHeadings, grokTrustPathFromHeading },
      )
    })

  program
    .command('discard <id>')
    .description('remove a run worktree and discard its branch')
    .option('--force', 'discard a branch with unique commits')
    .allowExcessArguments(false)
    .action(async (id, options) => {
      const flags = optionFlags(options)
      await discardRun(resolveRunIdentifier(db(), id), {
        force: flags.has('force'),
        auditReason: auditReason(flags),
        presentation,
      })
    })

  program
    .command('stop <id>')
    .description('stop a live run and its processes')
    .allowExcessArguments(false)
    .action(async (id) => {
      await stopRun(
        resolveRunIdentifier(db(), id),
        { force: false, auditReason: null, presentation },
        {
          lifecycleCheckpoint,
          planRunProcessTermination: planRecordedRunTermination,
          terminateRunProcesses: confirmRunProcessTermination,
          checkSharedGitConfig: (input) =>
            terminalSharedGitConfigForRun({
              runId: input.runId,
              writesJob: Boolean(JOBS[input.job]?.needs.writesRepo),
              worktree: input.worktree,
            }),
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
      const flags = optionFlags(options)
      await abandonRun(
        resolveRunIdentifier(db(), id),
        {
          force: flags.has('force'),
          note: flags.flag('note'),
          auditReason: auditReason(flags),
          presentation,
        },
        { lifecycleCheckpoint },
      )
    })
}
