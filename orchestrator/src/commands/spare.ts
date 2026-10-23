// concern: cli
/** Registers the spare-hands lane adapter. Must not own its behavior. */
import type { Command } from 'commander'
import { spareRunCommand } from '../spare/spare-runner.ts'
import { write } from './support.ts'

export function register(program: Command): void {
  const spare = program
    .command('spare')
    .description('the spare-hands lane: best-effort jobs for free-tier agents')

  spare
    .command('run')
    .description('work the spare queue once and print the night summary')
    .option('--job <name>', 'which spare job to run', 'docs-drift')
    .option('--until <HH:MM>', 'stop at this clock time instead of spare.stop_time')
    .allowExcessArguments(false)
    .action(async (options) => {
      const code = await spareRunCommand({ job: options.job, until: options.until }, (line) =>
        write(`${line}\n`),
      )
      if (code) process.exitCode = code
    })
}
