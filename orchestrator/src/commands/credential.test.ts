import { expect, test } from 'bun:test'
import { Command } from 'commander'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { registerCredentialCommands, validateBindingExclusivity } from './credential.ts'

type ParsedResolve = {
  name: string
  argv: string[]
  project?: string
  revealToEnv?: string
}

async function parseResolve(argv: string[]): Promise<ParsedResolve> {
  const program = new Command()
    .enablePositionalOptions()
    .exitOverride()
    .allowUnknownOption(false)
    .allowExcessArguments(false)
  registerCredentialCommands(program)
  const credential = program.commands.find((command) => command.name() === 'credential')!
  const resolve = credential.commands.find((command) => command.name() === 'resolve')!
  let parsed: ParsedResolve | undefined
  resolve.action((name: string, childArgv: string[], options: ParsedResolve) => {
    parsed = {
      name,
      argv: childArgv,
      project: options.project,
      revealToEnv: options.revealToEnv,
    }
  })

  await program.parseAsync(['credential', 'resolve', ...argv], { from: 'user' })
  return parsed!
}

test('credential resolve parses options after its name and preserves argv after --', async () => {
  expect(await parseResolve(['openrouter/api-key', '--project', PLATFORM_SLUG])).toEqual({
    name: 'openrouter/api-key',
    argv: [],
    project: PLATFORM_SLUG,
    revealToEnv: undefined,
  })
  expect(
    await parseResolve([
      'openrouter/api-key',
      '--project',
      PLATFORM_SLUG,
      '--reveal-to-env',
      'KEY',
      '--',
      'ls',
      '-la',
    ]),
  ).toEqual({
    name: 'openrouter/api-key',
    argv: ['ls', '-la'],
    project: PLATFORM_SLUG,
    revealToEnv: 'KEY',
  })
})

test('account commands expose reach while prefer names account only as a slot', () => {
  const program = new Command()
  registerCredentialCommands(program)
  const credential = program.commands.find((command) => command.name() === 'credential')!
  const command = (name: string) =>
    credential.commands.find((candidate) => candidate.name() === name)!
  expect(command('set').options.map((option) => option.long)).toContain('--account')
  expect(command('set').options.map((option) => option.long)).toContain('--reach')
  expect(command('reach').options.map((option) => option.long)).toContain('--spaces')
  expect(command('prefer').options.map((option) => option.long)).not.toContain('--account')
  const useDescription = command('prefer').options.find(
    (option) => option.long === '--use',
  )?.description
  expect(useDescription).toContain('personal@account')
  expect(useDescription).not.toContain('shared@account')
})

test('binding exclusivity refuses --project combined with --account or --space', () => {
  for (const options of [
    { project: 'project-one', account: true },
    { project: 'project-one', space: 'space-one' },
  ]) {
    expect(() => validateBindingExclusivity(options), JSON.stringify(options)).toThrow(
      '--account, --project, and --space are mutually exclusive',
    )
  }
})
