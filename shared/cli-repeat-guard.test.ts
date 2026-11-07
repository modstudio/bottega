import { expect, test } from 'bun:test'
import { Command, Option } from 'commander'
import { refuseRepeatedOptions, repeatable } from './cli-repeat-guard.ts'

function program(): Command {
  const command = new Command().exitOverride()
  command
    .command('run')
    .option('--value <value>')
    .action(() => undefined)
  refuseRepeatedOptions(command)
  return command
}

test('a repeated single-valued option is refused and parse state resets', async () => {
  const command = program()
  await expect(
    command.parseAsync(['run', '--value', 'first', '--value', 'second'], { from: 'user' }),
  ).rejects.toThrow('--value may be supplied only once; received first and second')
  await expect(command.parseAsync(['run', '--value', 'only'], { from: 'user' })).resolves.toBe(
    command,
  )
})

test('a marked collector accumulates repeated values', async () => {
  const command = new Command().exitOverride()
  let received: string[] = []
  command
    .addOption(
      repeatable(
        new Option('--value <value>').argParser((value, previous: string[] = []) => [
          ...previous,
          value,
        ]),
      ).default([]),
    )
    .action((options) => {
      received = options.value
    })
  refuseRepeatedOptions(command)
  await command.parseAsync(['--value', 'first', '--value', 'second'], { from: 'user' })
  expect(received).toEqual(['first', 'second'])
})

test('a variadic option accepts multiple values', async () => {
  const command = new Command()
    .exitOverride()
    .option('--value <values...>')
    .action(() => undefined)
  refuseRepeatedOptions(command)
  await expect(command.parseAsync(['--value', 'first', 'second'], { from: 'user' })).resolves.toBe(
    command,
  )
})
