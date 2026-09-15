import { expect, test } from 'bun:test'
import { CLI_COMMANDS } from './args.ts'
import { program } from './program.ts'

test('canon command recognition is pinned to the Commander registry', () => {
  const registered = new Set([
    'init-db',
    ...program.commands.flatMap((command) => [command.name(), ...command.aliases()]),
  ])
  expect([...CLI_COMMANDS].sort()).toEqual([...registered].sort())
})
