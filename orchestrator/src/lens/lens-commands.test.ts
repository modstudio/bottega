import { expect, test } from 'bun:test'
import { Command } from 'commander'
import { registerLensCommands } from '../commands/lens.ts'

const slots = JSON.stringify({
  type: 'object',
  properties: { looks_for: { type: 'string' } },
  additionalProperties: false,
})

function setCommand(title: string, requiresExecution: boolean): string[] {
  return [
    'lens',
    'set',
    'command-fixture',
    '--title',
    title,
    '--question',
    'What should be checked?',
    '--excludes',
    'Unrelated concerns.',
    '--slots',
    slots,
    '--enabled',
    'true',
    '--requires-execution',
    String(requiresExecution),
    '--reason',
    'command test',
    '--json',
  ]
}

test('lens set adds and changes a lens including requires-execution', async () => {
  const output: string[] = []
  const presentation = { log: (value: string) => output.push(value) }
  for (const argv of [setCommand('First title', false), setCommand('Changed title', true)]) {
    const program = new Command().exitOverride()
    registerLensCommands(program, presentation)
    await program.parseAsync(['node', 'orch', ...argv])
  }

  expect(JSON.parse(output[0]!)).toMatchObject({
    id: 'command-fixture',
    title: 'First title',
    requires_execution: false,
  })
  expect(JSON.parse(output[1]!)).toMatchObject({
    id: 'command-fixture',
    title: 'Changed title',
    version: 2,
    requires_execution: true,
  })
})
