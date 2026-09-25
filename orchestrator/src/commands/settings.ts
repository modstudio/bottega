// concern: settings-cli
/** Owns only the `orch settings` grammar and presentation. */
import type { Command } from 'commander'
import {
  settingsAdoptCommand,
  settingsEnvImportCommand,
  settingsRenderWriteCommand,
  settingsRestoreCommand,
} from '../settings/settings-apply-commands.ts'
import {
  settingsImportCommand,
  settingsPermissionCommand,
  settingsRenderCheckCommand,
} from '../settings/settings-commands.ts'
import { collect, log, optionFlags } from './support.ts'

export function register(program: Command): void {
  const settings = program.command('settings')
  settings
    .command('import')
    .option('--user')
    .option('--project <name>')
    .option('--dry-run')
    .action(async (options) => {
      await settingsImportCommand(optionFlags(options), {
        log,
        cwd: process.cwd,
        exitCode: (code: number) => {
          process.exitCode = code
        },
      })
    })
  settings
    .command('adopt')
    .option('--user')
    .option('--project <name>')
    .option('--all')
    .argument('[rules...]')
    .action(async (rules: string[], options) => {
      await settingsAdoptCommand(optionFlags(options), rules, {
        log,
        cwd: process.cwd,
        exitCode: (code: number) => {
          process.exitCode = code
        },
      })
    })
  const permission = settings.command('permission')
  for (const operation of ['add', 'remove'] as const) {
    permission
      .command(operation)
      .option('--user')
      .option('--project <name>')
      .requiredOption('--list <name>')
      .requiredOption('--rule <rule>')
      .requiredOption('--expect <revision>')
      .option('--reason <text>')
      .option('--json')
      .action(async (options) => {
        const result = await settingsPermissionCommand(optionFlags(options), operation)
        if (options.json) log(JSON.stringify(result))
        else log(result.message ?? `updated permissions.${options.list} at ${result.revision}`)
      })
  }
  settings
    .command('restore')
    .option('--user')
    .option('--project <name>')
    .option('--force')
    .argument('<backup>')
    .action((backup: string, options) => {
      settingsRestoreCommand(optionFlags(options), backup, {
        log,
        cwd: process.cwd,
        exitCode: (code: number) => {
          process.exitCode = code
        },
      })
    })
  const env = settings.command('env')
  env
    .command('import')
    .option('--user')
    .option('--project <name>')
    .option('--dry-run')
    .action(async (options) => {
      await settingsEnvImportCommand(optionFlags(options), {
        log,
        cwd: process.cwd,
        exitCode: (code: number) => {
          process.exitCode = code
        },
      })
    })
  settings
    .command('render')
    .option('--check')
    .option('--write')
    .option('--yes')
    .option('--user')
    .option('--project <name>')
    .option('--json')
    .option('--drop-env <key>', '', collect, [])
    .action(async (options) => {
      const flags = optionFlags(options)
      if (flags.has('check') === flags.has('write')) {
        throw new Error(
          'refusing settings render: pass --check or --write\ncleared by: choose one render operation',
        )
      }
      const presentation = {
        log,
        cwd: process.cwd,
        exitCode: (code: number) => {
          process.exitCode = code
        },
      }
      if (flags.has('write')) await settingsRenderWriteCommand(flags, presentation)
      else await settingsRenderCheckCommand(flags, presentation)
    })
}
