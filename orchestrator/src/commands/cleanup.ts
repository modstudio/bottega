// concern: cli
/** Registers cleanup adapters. Must not own cleanup decisions. */

import { existsSync, writeFileSync } from 'node:fs'
import type { Command } from 'commander'
import { type CleanupPresentation, discardRun } from '../cleanup.ts'
import { sweepRuns } from '../cleanup-sweep.ts'
import { grokTrustHeadings, grokTrustPathFromHeading } from '../grok-trust.ts'
import { terminateRunProcesses } from '../run-process.ts'
import { abandonRun, stopRun } from '../run-stop.ts'
import { log, optionFlags } from './support.ts'

function keptBranchLine(
  branch: string,
  uniqueCount: number,
  afterCutCount: number | null,
  id: number,
): string {
  const reason =
    afterCutCount === null
      ? `${uniqueCount} commit(s) reachable only from this branch`
      : `deleting it would lose commits reachable from no other ref; ${afterCutCount} commit(s) after the cut`
  return `kept branch ${branch}: ${reason} — merge it, or orch discard ${id} --force to delete it after checking no other run owns it`
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
    .option('--project <value>')
    .option('--force')
    .option('--dry-run')
    .allowExcessArguments(false)
    .action(async (options) => {
      const flags = optionFlags(options)
      await sweepRuns(
        {
          dryRun: flags.has('dry-run'),
          project: flags.flag('project'),
          force: flags.has('force'),
          presentation,
        },
        { grokTrustHeadings, grokTrustPathFromHeading },
      )
    })

  program
    .command('discard <id>')
    .option('--force')
    .allowExcessArguments(false)
    .action(async (id, options) => {
      const flags = optionFlags(options)
      await discardRun(Number(id), {
        force: flags.has('force'),
        auditReason: auditReason(flags),
        presentation,
      })
    })

  program
    .command('stop <id>')
    .allowExcessArguments(false)
    .action(async (id) => {
      await stopRun(
        Number(id),
        { force: false, auditReason: null, presentation },
        { lifecycleCheckpoint, terminateRunProcesses },
      )
    })

  program
    .command('abandon <id>')
    .option('--note <value>')
    .option('--force')
    .allowExcessArguments(false)
    .action(async (id, options) => {
      const flags = optionFlags(options)
      await abandonRun(
        Number(id),
        {
          force: flags.has('force'),
          note: flags.flag('note'),
          auditReason: auditReason(flags),
          presentation,
        },
        { lifecycleCheckpoint, terminateRunProcesses },
      )
    })
}
