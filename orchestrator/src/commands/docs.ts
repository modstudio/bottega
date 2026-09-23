// concern: cli
/** Registers documentation and register adapters. Must not own their behavior. */
import type { Command } from 'commander'
import { canonLintCommand, dispatchCanonCommand } from '../canon/canon-commands.ts'
import { docCommand } from '../doc/doc-commands.ts'
import { portCommand } from '../porting/port-commands.ts'
import { projectCommand } from '../project/project-commands.ts'
import { requireRecordSpaceMembership } from '../record/record-space.ts'
import { log, optionFlags, write, writeStdout } from './support.ts'

export function register(program: Command): void {
  program
    .command('doc [args...]')
    .option('--scope <value>')
    .option('--subject <value>')
    .option('--title <value>')
    .option('--file <value>')
    .option('--reason <value>')
    .option('--author <value>')
    .option('--delivery <value>')
    .option('--force-inject <value>')
    .option('--cwd <value>')
    .option('--json')
    .action(async (args, options) => {
      const argv = ['doc', ...args]
      const flags = optionFlags(options)
      await docCommand(argv[1] ?? 'list', argv, flags, {
        log,
        error: console.error,
        write,
        stdinText: () => Bun.stdin.text(),
        stdinIsTTY: process.stdin.isTTY,
        cwd: process.cwd,
      })
    })

  program
    .command('canon [args...]')
    .option('--cwd <value>')
    .option('--job <value>')
    .option('--slug <value>')
    .option('--agent <value>')
    .option('--project <value>')
    .option('--reason <value>')
    .option('--baseline <value>')
    .option('--accept')
    .option('--all')
    .option('--json')
    .option('--force')
    .option('--strict')
    .option('--write-baseline')
    .option('--check')
    .action(async (args, options) => {
      const argv = ['canon', ...args]
      const flags = optionFlags(options)
      await import('../jobs/jobs.ts')
      if (argv[1] === 'lint') {
        canonLintCommand(flags, {
          log,
          exitCode: (code) => {
            process.exitCode = code
          },
          cwd: process.cwd,
        })
        return
      }
      await dispatchCanonCommand(argv, flags, {
        log,
        exitCode: (code) => {
          process.exitCode = code
        },
        cwd: process.cwd,
      })
    })

  program
    .command('port [args...]')
    .option('--reason <value>')
    .option('--sources <value>')
    .option('--note <value>')
    .option('--title <value>')
    .option('--file <value>')
    .option('--all')
    .option('--json')
    .option('--clear')
    .option('--dry-run')
    .option('--replace')
    .action(async (args, options) => {
      const argv = ['port', ...args]
      const flags = optionFlags(options)
      await portCommand(argv[1], argv[2], argv, flags, {
        log,
        writeStdout,
        exitCode: (code) => {
          process.exitCode = code
        },
      })
    })

  program
    .command('project [args...]')
    .option('--name <value>')
    .option('--stack <value>')
    .option('--settings <value>')
    .option('--path <value>')
    .option('--axis <value>')
    .option('--lens <value>')
    .option('--version <value>')
    .option('--reason <value>')
    .option('--no-canon')
    .option('--canon')
    .option('--allow-incomplete')
    .option('--json')
    .option('--apply')
    .option('--retired')
    .option('--undo')
    .action(async (args, options) => {
      const argv = ['project', ...args]
      await projectCommand(
        argv[1] ?? 'list',
        argv,
        optionFlags(options),
        { log, cwd: process.cwd },
        { requireSpaceMembership: requireRecordSpaceMembership },
      )
    })
}
