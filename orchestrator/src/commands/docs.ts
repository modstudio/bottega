// concern: cli
/** Registers documentation and register adapters. Must not own their behavior. */
import type { Command } from 'commander'
import { canonCommand } from '../canon-commands.ts'
import { docCommand } from '../doc-commands.ts'
import { portCommand } from '../port-commands.ts'
import { projectCommand } from '../project-commands.ts'
import { log, optionFlags, write, writeStdout } from './support.ts'

export function register(program: Command): void {
  program.command('doc [args...]').option('--scope <value>').option('--subject <value>').option('--title <value>')
    .option('--file <value>').option('--reason <value>').option('--author <value>').option('--delivery <value>')
    .option('--force-inject <value>').option('--cwd <value>').option('--json').action(async (args, options) => {
    const argv = ['doc', ...args]; const flags = optionFlags(options)
    await docCommand(argv[1] ?? 'list', argv, flags, {
      log, error: console.error, write,
      stdinText: () => Bun.stdin.text(), stdinIsTTY: process.stdin.isTTY, cwd: process.cwd,
    })
  })

  program.command('canon [args...]').option('--cwd <value>').option('--job <value>').option('--slug <value>')
    .option('--agent <value>').option('--all').option('--json').option('--force').action(async (args, options) => {
    const argv = ['canon', ...args]; const flags = optionFlags(options)
    await import('../jobs.ts')
    await canonCommand(argv, flags, { log, exitCode: (code) => { process.exitCode = code }, cwd: process.cwd })
  })

  program.command('port [args...]').option('--reason <value>').option('--sources <value>').option('--note <value>')
    .option('--title <value>').option('--file <value>').option('--all').option('--json').option('--clear')
    .option('--dry-run').option('--replace').action(async (args, options) => {
    const argv = ['port', ...args]; const flags = optionFlags(options)
    await portCommand(argv[1], argv[2], argv, flags, {
      log, writeStdout, exitCode: (code) => { process.exitCode = code },
    })
  })

  program.command('project [args...]').option('--name <value>').option('--stack <value>').option('--settings <value>')
    .option('--path <value>').option('--axis <value>').option('--lens <value>').option('--version <value>')
    .option('--reason <value>').option('--no-canon').option('--canon').option('--allow-incomplete').option('--json')
    .option('--apply').action((args, options) => {
    const argv = ['project', ...args]
    projectCommand(argv[1] ?? 'list', argv, optionFlags(options), { log, cwd: process.cwd })
  })
}
