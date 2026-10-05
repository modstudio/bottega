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
import {
  applyMachineSettings,
  printMachineSettingsApplyResults,
} from '../settings/settings-machine-apply.ts'
import {
  editMachineSettingsPermission,
  listMachineSettingsPermissions,
} from '../settings/settings-machine-permissions.ts'
import { collect, log, optionFlags } from './support.ts'

export function register(program: Command): void {
  const settings = program.command('settings')
  settings
    .command('apply')
    .option('--check')
    .action(async (options) => {
      const check = Boolean(options.check)
      const results = await applyMachineSettings({ check })
      printMachineSettingsApplyResults(results, log)
      if (results.some((result) => result.outcome === 'refused' || (check && result.changed))) {
        process.exitCode = 1
      }
    })
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
  permission
    .command('list')
    .option('--machine')
    .option('--json')
    .action((options) => {
      if (!options.machine) {
        throw new Error(
          'refusing hosted permission listing; run orch settings permission list --machine',
        )
      }
      for (const line of listMachineSettingsPermissions(Boolean(options.json))) log(line)
    })
  for (const operation of ['add', 'remove'] as const) {
    permission
      .command(operation)
      .option('--user')
      .option('--project <name>')
      .option('--machine')
      .requiredOption('--list <name>')
      .requiredOption('--rule <rule>')
      .option('--expect <revision>')
      .option('--reason <text>')
      .option('--json')
      .action(async (options) => {
        const flags = optionFlags(options)
        if (
          flags.has('machine') &&
          (flags.has('user') ||
            flags.flag('project') ||
            flags.flag('expect') ||
            flags.flag('reason'))
        )
          throw new Error(
            'refusing machine permission edit: --machine cannot be combined with --user, --project, --expect, or --reason',
          )
        if (flags.has('machine')) {
          const result = editMachineSettingsPermission({
            operation,
            list: flags.flag('list'),
            rule: flags.flag('rule'),
          })
          if (options.json) log(JSON.stringify(result))
          else {
            log(result.message)
            log(
              'machine permissions take effect at the next session start (or after `orch settings apply`)',
            )
          }
          return
        }
        const result = await settingsPermissionCommand(flags, operation)
        if (options.json) log(JSON.stringify(result))
        else log(result.message ?? `updated permissions.${options.list} at ${result.revision}`)
      })
  }
  for (const operation of ['drop', 'undrop'] as const) {
    permission
      .command(operation)
      .requiredOption('--list <name>')
      .requiredOption('--rule <rule>')
      .option('--json')
      .action((options) => {
        const flags = optionFlags(options)
        const result = editMachineSettingsPermission({
          operation,
          list: flags.flag('list'),
          rule: flags.flag('rule'),
        })
        if (options.json) log(JSON.stringify(result))
        else {
          log(result.message)
          log(
            'machine permissions take effect at the next session start (or after `orch settings apply`)',
          )
        }
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
