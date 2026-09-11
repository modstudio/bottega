// concern: cli
/** Registers health reporting adapters. Must not own their behavior. */
import type { Command } from 'commander'
import { candidates, pick } from '../route.ts'
import { JOBS } from '../jobs.ts'
import { acpRuntimeGaps } from '../transport.ts'
import { blockersCommand, healthCommand } from '../health-commands.ts'
import { doctorCommand } from '../doctor.ts'
import { reclassifyFailuresCommand } from '../failure-commands.ts'
import { booleanOptions, cliFlags, rawArgv, valueOptions } from './support.ts'

export function register(program: Command): void {
  const blockers = valueOptions(program.command('blockers'), ['days'])
  booleanOptions(blockers, ['json']).action((_options, command) => blockersCommand(cliFlags(rawArgv(command)), { log: console.log }))

  const health = valueOptions(program.command('health'), ['days'])
  booleanOptions(health, ['json']).action((_options, command) => healthCommand(cliFlags(rawArgv(command)), { log: console.log }))

  booleanOptions(program.command('reclassify-failures'), ['dry-run']).action((_options, command) => {
    reclassifyFailuresCommand(cliFlags(rawArgv(command)), { log: console.log })
  })

  booleanOptions(program.command('doctor'), ['wake']).action(async (_options, command) => {
    await doctorCommand(cliFlags(rawArgv(command)), {
      log: console.log, exitCode: (code) => { process.exitCode = code }, candidates, pick,
      jobs: () => Object.keys(JOBS), acpRuntimeGaps,
    })
  })
}
