// concern: settings-cli
/** Owns only the `orch settings` grammar and presentation. */
import type { Command } from 'commander'
import { settingsImportCommand, settingsRenderCheckCommand } from '../settings/settings-commands.ts'
import { log, optionFlags } from './support.ts'

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
        exitCode: (code) => {
          process.exitCode = code
        },
      })
    })
  settings
    .command('render')
    .option('--check')
    .option('--user')
    .option('--project <name>')
    .action(async (options) => {
      const flags = optionFlags(options)
      if (!flags.has('check')) {
        throw new Error(
          'refusing settings render: pass --check\ncleared by: orch settings render --check',
        )
      }
      await settingsRenderCheckCommand(flags, {
        log,
        cwd: process.cwd,
        exitCode: (code) => {
          process.exitCode = code
        },
      })
    })
}
