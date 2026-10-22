// concern: settings-cli
/** Owns only the `bottega machine settings` grammar and presentation. */
import type { Command } from 'commander'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  settingsAdoptCommand,
  settingsEnvImportCommand,
  settingsRenderWriteCommand,
  settingsRestoreCommand,
} from '../settings/settings-apply-commands.ts'
import {
  settingsAutoModeCommand,
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

function registerSettingsSources(settings: Command): void {
  settings
    .command('apply')
    .description('apply managed settings and canon to installed harnesses')
    .option('--check', 'report machine settings drift without writing files')
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
    .description('import a settings file into the document store')
    .option('--user', 'target the signed-in user settings')
    .option('--project <name>', 'registered project whose settings are imported')
    .option('--dry-run', 'report the import without writing a document')
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
    .description('adopt local permission rules into canonical settings')
    .option('--user', 'target the signed-in user settings')
    .option('--project <name>', 'registered project whose rules are adopted')
    .option('--all', 'adopt every local permission rule')
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
  registerAutoMode(settings)
}

function registerAutoMode(settings: Command): void {
  const autoMode = settings.command('auto-mode').description('manage canonical auto-mode rules')
  for (const operation of ['add', 'remove'] as const) {
    autoMode
      .command(operation)
      .description(`${operation} a canonical auto-mode rule`)
      .option('--user', 'target the signed-in user settings')
      .option('--project <name>', 'registered project whose rule is edited')
      .requiredOption('--list <name>', 'auto-mode list containing the rule')
      .requiredOption('--rule <rule>', 'auto-mode rule to edit')
      .option('--expect <revision>', 'document revision required before editing')
      .option('--reason <text>', 'reason recorded for the settings revision')
      .option('--json', 'write the auto-mode result as JSON')
      .action(async (options) => {
        const result = await settingsAutoModeCommand(optionFlags(options), operation)
        if (options.json) log(JSON.stringify(result))
        else log(result.message ?? `updated autoMode.${options.list} at ${result.revision}`)
      })
  }
}

export function register(program: Command): void {
  const settings = program.command('settings').description('manage canonical Claude settings')
  registerSettingsSources(settings)
  const permission = settings.command('permission').description('manage canonical permission rules')
  permission
    .command('list')
    .description('list machine permission overlays')
    .option('--machine', 'list the machine permission overlay')
    .option('--json', 'write the permission overlay as JSON')
    .action((options) => {
      if (!options.machine) {
        throw new Error(
          `refusing hosted permission listing; run ${PLATFORM_SLUG} machine settings permission list --machine`,
        )
      }
      for (const line of listMachineSettingsPermissions(Boolean(options.json))) log(line)
    })
  for (const operation of ['add', 'remove'] as const) {
    permission
      .command(operation)
      .description(`${operation} a canonical or machine permission rule`)
      .option('--user', 'target the signed-in user settings')
      .option('--project <name>', 'registered project whose rule is edited')
      .option('--machine', 'edit the machine permission overlay')
      .requiredOption('--list <name>', 'permission list containing the rule')
      .requiredOption('--rule <rule>', 'permission rule to edit')
      .option('--expect <revision>', 'document revision required before editing')
      .option('--reason <text>', 'reason recorded for the settings revision')
      .option('--json', 'write the permission result as JSON')
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
              `machine permissions take effect at the next session start (or after \`${PLATFORM_SLUG} machine settings apply\`)`,
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
      .description(
        operation === 'drop'
          ? 'suppress a machine permission rule'
          : 'stop suppressing a machine permission rule',
      )
      .requiredOption('--list <name>', 'permission list containing the rule')
      .requiredOption('--rule <rule>', 'permission rule to edit')
      .option('--json', 'write the permission result as JSON')
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
            `machine permissions take effect at the next session start (or after \`${PLATFORM_SLUG} machine settings apply\`)`,
          )
        }
      })
  }
  settings
    .command('restore')
    .description('restore user settings from a rendered backup')
    .option('--user', 'target the user settings file')
    .option('--project <name>', 'project target, which restore refuses')
    .option('--force', 'restore despite later settings writes')
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
  const env = settings.command('env').description('manage settings environment values')
  env
    .command('import')
    .description('move user settings environment values into the secrets file')
    .option('--user', 'target the user settings file')
    .option('--project <name>', 'project target, which environment import refuses')
    .option('--dry-run', 'report the import without writing files or settings')
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
    .description('compare or write canonical settings to a settings file')
    .option('--check', 'report drift without writing the settings file')
    .option('--write', 'write canonical settings to the settings file')
    .option('--yes', 'confirm writing the settings file')
    .option('--user', 'target the user settings file')
    .option('--project <name>', 'registered project whose settings are rendered')
    .option('--json', 'write the settings drift report as JSON')
    .option(
      '--drop-env <key>',
      'environment key deliberately removed during rendering',
      collect,
      [],
    )
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
