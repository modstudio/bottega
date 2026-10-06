// concern: cli
/** Registers documentation and register adapters. Must not own their behavior. */
import { type Command, Option } from 'commander'
import { canonLintCommand, dispatchCanonCommand } from '../canon/canon-commands.ts'
import { docCommand } from '../doc/doc-commands.ts'
import { portCommand } from '../porting/port-commands.ts'
import { projectCommand } from '../project/project-commands.ts'
import { requireRecordSpaceMembership } from '../record/record-space.ts'
import { isOrchWorkerProcess, type ProcessInventory } from '../run/run-process.ts'
import { log, optionFlags, write, writeStdout } from './support.ts'

type Flags = { has(name: string): boolean }

class NoParentOption extends Option {
  override attributeName(): string {
    return 'noParent'
  }
}

export function assertUserCanonHydrateAllowed(
  flags: Flags,
  env: Record<string, string | undefined> = process.env,
  pid = process.pid,
  inventory?: ProcessInventory,
): void {
  if (!isOrchWorkerProcess(env, pid, inventory)) return
  if (flags.has('check') && !flags.has('adopt')) return
  const command = `orch canon hydrate --user${flags.has('adopt') ? ' --adopt' : ''}`
  throw new Error(
    `refusing user canon hydrate from an orch worker run; an operator must run ${command}`,
  )
}

export function register(program: Command): void {
  program
    .command('doc [args...]')
    .option('--scope <value>')
    .option('--subject <value>')
    .option('--user')
    .option('--title <value>')
    .option('--file <value>')
    .option('--reason <value>')
    .option('--author <value>')
    .option('--delivery <value>')
    .option('--audience <value>')
    .option('--match <value>')
    .option('--body-match <value>')
    .option('--parent <slug>')
    .addOption(new NoParentOption('--no-parent'))
    .option('--position <value>')
    .option('--force-inject <value>')
    .option('--expect <revision>')
    .option('--cwd <value>')
    .option('--k <value>')
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
        exitCode: (code) => {
          process.exitCode = code
        },
      })
    })

  program
    .command('canon [args...]')
    .option('--cwd <value>')
    .option('--job <value>')
    .option('--slug <value>')
    .option('--agent <value>')
    .option('--project <value>')
    .option('--user')
    .option('--reason <value>')
    .option('--baseline <value>')
    .option('--accept')
    .option('--all')
    .option('--json')
    .option('--force')
    .option('--strict')
    .option('--write-baseline')
    .option('--check')
    .option('--harness <value>')
    .option('--role <value>')
    .option('--dry-run')
    .option('--adopt')
    .action(async (args, options) => {
      const argv = ['canon', ...args]
      const flags = optionFlags(options)
      if (argv[1] === 'hydrate' && flags.has('user')) assertUserCanonHydrateAllowed(flags)
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
    .option('--project <value>')
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
