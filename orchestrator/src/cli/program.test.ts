import { expect, test } from 'bun:test'
import { CLI_COMMANDS } from './args.ts'
import { isHelpShapedInvocation } from './orch.ts'
import { program } from './program.ts'

test('the outer CLI classifies every informational invocation without consulting the store', () => {
  for (const argv of [
    [],
    ['help'],
    ['--help'],
    ['-h'],
    ['jobs', '--help'],
    ['jobs', '-h'],
    ['--version'],
  ]) {
    expect(isHelpShapedInvocation(argv)).toBeTrue()
  }
  expect(isHelpShapedInvocation(['jobs'])).toBeFalse()
})

test('canon command recognition is pinned to the Commander registry', () => {
  const registered = new Set([
    'init-db',
    ...program.commands.flatMap((command) => [command.name(), ...command.aliases()]),
  ])
  expect([...CLI_COMMANDS].sort()).toEqual([...registered].sort())
})

test('probe is listed with a one-line description', () => {
  const probe = program.commands.find((command) => command.name() === 'probe')
  expect(probe?.description()).toBe('clear a vendor-quota exclusion once the agent answers')
})
