import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Command } from 'commander'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  forgetRecordSessionToken,
  writeRecordSessionToken,
} from '../../../shared/record-session.ts'
import { STATE_HOME_ENV } from '../../../shared/state-directory.ts'
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

test('credential set refuses a missing owner before any hosted call', async () => {
  const root = mkdtempSync(join(tmpdir(), 'credential-owner-edge-'))
  const previousFetch = globalThis.fetch
  const previousStateHome = process.env[STATE_HOME_ENV]
  const previousKeyStore = process.env.BOTTEGA_KEYSTORE
  const previousRecordApi = process.env.BOTTEGA_RECORD_API_URL
  let hostedCalls = 0
  process.env[STATE_HOME_ENV] = root
  process.env.BOTTEGA_KEYSTORE = 'file'
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  writeRecordSessionToken('fixture-token')
  globalThis.fetch = (async () => {
    hostedCalls += 1
    throw new Error('credential owner refusal reached the hosted record')
  }) as typeof fetch
  const program = new Command().exitOverride()
  registerCredentialCommands(program)
  try {
    await expect(
      program.parseAsync(['credential', 'set', 'provider/api-key'], { from: 'user' }),
    ).rejects.toThrow(
      'credential set writes to a record space and names none; pass --space <slug>, or --project <name>, or --account',
    )
    expect(hostedCalls).toBe(0)
  } finally {
    globalThis.fetch = previousFetch
    forgetRecordSessionToken()
    if (previousStateHome === undefined) delete process.env[STATE_HOME_ENV]
    else process.env[STATE_HOME_ENV] = previousStateHome
    if (previousKeyStore === undefined) delete process.env.BOTTEGA_KEYSTORE
    else process.env.BOTTEGA_KEYSTORE = previousKeyStore
    if (previousRecordApi === undefined) delete process.env.BOTTEGA_RECORD_API_URL
    else process.env.BOTTEGA_RECORD_API_URL = previousRecordApi
    rmSync(root, { recursive: true, force: true })
  }
})
