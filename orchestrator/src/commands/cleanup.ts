// concern: cli
/** Registers cleanup adapters. Must not own cleanup decisions. */
import type { Command } from 'commander'
import { existsSync, writeFileSync } from 'node:fs'
import { discardRun, type CleanupPresentation } from '../cleanup.ts'
import { sweepRuns } from '../cleanup-sweep.ts'
import { abandonRun, stopRun } from '../run-stop.ts'
import { terminateRunProcesses } from '../run-process.ts'
import { grokTrustHeadings, grokTrustPathFromHeading } from '../grok-trust.ts'
import { booleanOptions, cliFlags, log, rawArgv, valueOptions } from './support.ts'

function keptBranchLine(branch: string, uniqueCount: number, afterCutCount: number | null, id: number): string {
  const reason = afterCutCount === null
    ? `${uniqueCount} commit(s) reachable only from this branch`
    : `deleting it would lose commits reachable from no other ref; ${afterCutCount} commit(s) after the cut`
  return `kept branch ${branch}: ${reason} — merge it, or orch discard ${id} --force to delete it after checking no other run owns it`
}

const presentation: CleanupPresentation = {
  log: log, error: (...values) => console.error(...values),
  setExitCode: (code) => { process.exitCode = code }, keptBranchLine,
}

function auditReason(argv: string[]): string | null {
  const flags = cliFlags(argv)
  const scorer = flags.flag('scorer')
  if (scorer) return `--scorer ${scorer}`
  if (flags.has('force')) return '--force'
  return flags.flag('unreviewed') ?? flags.flag('note') ?? null
}

function lifecycleCheckpoint(name: string): void {
  if (process.env.ORCH_TEST_LIFECYCLE_CHECKPOINT !== name) return
  const ready = process.env.ORCH_TEST_LIFECYCLE_READY; const release = process.env.ORCH_TEST_LIFECYCLE_RELEASE
  if (!ready || !release) return
  writeFileSync(ready, `${name}\n`)
  while (!existsSync(release)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
}

export function register(program: Command): void {
  const sweep = valueOptions(program.command('sweep'), ['project'])
  booleanOptions(sweep, ['force', 'dry-run']).action(async (_options, command) => {
    const argv = rawArgv(command); const flags = cliFlags(argv)
    await sweepRuns({ dryRun: flags.has('dry-run'), project: flags.flag('project'), force: flags.has('force'), presentation }, { grokTrustHeadings, grokTrustPathFromHeading })
  })

  booleanOptions(program.command('discard <id>'), ['force']).action(async (id, _options, command) => {
    const argv = rawArgv(command)
    await discardRun(Number(id), { force: cliFlags(argv).has('force'), auditReason: auditReason(argv), presentation })
  })

  program.command('stop <id>').action(async (id) => {
    await stopRun(Number(id), { force: false, auditReason: null, presentation }, { lifecycleCheckpoint, terminateRunProcesses })
  })

  const abandon = valueOptions(program.command('abandon <id>'), ['note'])
  booleanOptions(abandon, ['force']).action(async (id, _options, command) => {
    const argv = rawArgv(command); const flags = cliFlags(argv)
    await abandonRun(Number(id), { force: flags.has('force'), note: flags.flag('note'), auditReason: auditReason(argv), presentation }, { lifecycleCheckpoint, terminateRunProcesses })
  })
}
