// concern: cli
/** Registers review-lens adapters. Must not own lens registry decisions. */

import type { Command } from 'commander'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  lensEmitter,
  listLensesCommand,
  listProfilesCommand,
  setLensCommand,
  setProfileCommand,
  showLensCommand,
  showProfileCommand,
} from '../lens/lens-commands.ts'
import { log, productArgv } from './support.ts'

const jsonOption = (command: Command) => command.option('--json', 'print JSON output')
const reasonOption = (command: Command) =>
  command.option('--reason <value>', 'record why this change is being made')

export function registerLensCommands(
  program: Command,
  presentation: { log(value: string): void } = { log },
): void {
  const lens = program
    .command('lens')
    .description('inspect and change review lenses and profiles')
    .allowExcessArguments(true)
    .action(() => {
      throw new Error(`unknown: ${PLATFORM_SLUG} review lens. Try list | show | set | profile`)
    })
  jsonOption(lens.command('list').description('list review lenses'))
    .allowExcessArguments(false)
    .action((options) =>
      listLensesCommand(lensEmitter(productArgv('lens', ['list'], options), presentation)),
    )
  jsonOption(lens.command('show <lens>').description('show a review lens'))
    .allowExcessArguments(false)
    .action(async (id, options) => {
      const argv = productArgv('lens', ['show', id], options)
      showLensCommand(argv, lensEmitter(argv, presentation))
    })
  jsonOption(
    reasonOption(
      lens
        .command('set <lens>')
        .description('create a review lens version')
        .option('--title <value>', 'set the lens title')
        .option('--question <value>', 'set the question the lens answers')
        .option('--excludes <value>', 'set what the lens excludes')
        .option('--slots <value>', 'supply the slot schema inline')
        .option('--slots-file <value>', 'read the slot schema from this file')
        .option('--enabled <value>', 'enable or disable the lens')
        .option('--requires-execution <value>', 'declare whether the lens must execute code'),
    ),
  )
    .allowExcessArguments(false)
    .action(async (id, options) => {
      const argv = productArgv('lens', ['set', id], options)
      await setLensCommand(argv, lensEmitter(argv, presentation))
    })

  registerProfileCommands(lens, presentation)
}

function registerProfileCommands(lens: Command, presentation: { log(value: string): void }): void {
  const profile = lens
    .command('profile')
    .description('inspect and change review lens profiles')
    .action(() => {
      throw new Error(`unknown: ${PLATFORM_SLUG} review lens profile. Try list | show | set`)
    })
  profile
    .command('*', { hidden: true })
    .description('refuse an unknown review lens profile command')
    .action(() => {
      throw new Error(`unknown: ${PLATFORM_SLUG} review lens profile. Try list | show | set`)
    })
  jsonOption(
    profile
      .command('list [lens]')
      .description('list review lens profiles')
      .option('--project <value>', 'use the project space catalogue'),
  )
    .allowExcessArguments(false)
    .action((id, options) => {
      const argv = productArgv('lens', ['profile', 'list', ...(id ? [id] : [])], options)
      listProfilesCommand(argv, lensEmitter(argv, presentation))
    })
  jsonOption(
    profile
      .command('show <lens>')
      .description('show a review lens profile')
      .option('--axis <value>', 'select the profile axis')
      .option('--name <value>', 'select the profile name'),
  )
    .allowExcessArguments(false)
    .action((id, options) => {
      const argv = productArgv('lens', ['profile', 'show', id], options)
      showProfileCommand(argv, lensEmitter(argv, presentation))
    })
  jsonOption(
    reasonOption(
      profile
        .command('set <lens>')
        .description('create a review lens profile version')
        .option('--axis <value>', 'set the profile axis')
        .option('--name <value>', 'set the profile name')
        .option('--body <value>', 'supply the profile body inline')
        .option('--body-file <value>', 'read the profile body from this file')
        .option('--enabled <value>', 'enable or disable the profile')
        .option('--project <value>', 'use the project space catalogue'),
    ),
  )
    .allowExcessArguments(false)
    .action(async (id, options) => {
      const argv = productArgv('lens', ['profile', 'set', id], options)
      await setProfileCommand(argv, lensEmitter(argv, presentation))
    })
}
