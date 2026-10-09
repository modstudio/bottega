import { expect, test } from 'bun:test'
import { Command } from 'commander'
import { register } from './logic.ts'

test('lens set accepts the requires-execution option at the CLI edge', () => {
  const program = new Command()
  register(program)
  const lens = program.commands.find((command) => command.name() === 'lens')
  expect(lens?.options.some((option) => option.long === '--requires-execution')).toBe(true)
})
