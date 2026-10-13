// concern: ratchet-cli
/** Owns only the `orch ratchet` grammar and presentation. */

import type { Command } from 'commander'
import { runRatchet } from '../ratchet/ratchet-service.ts'

export function register(program: Command): void {
  program
    .command('ratchet')
    .requiredOption('--format <name>')
    .option('--staged')
    .option('--base <ref>')
    .option('--support <path>', '', (value, previous: string[]) => [...previous, value], [])
    .argument('<command...>')
    .allowUnknownOption(true)
    .action(async (command, options) => {
      if (options.staged && options.base) throw new Error('--staged cannot be combined with --base')
      const passed = await runRatchet({
        cwd: process.cwd(),
        format: options.format,
        staged: Boolean(options.staged),
        base: options.base,
        support: options.support,
        command,
      })
      if (!passed) process.exitCode = 1
    })
}
