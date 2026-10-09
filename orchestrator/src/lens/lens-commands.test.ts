import { expect, test } from 'bun:test'
import { lensCommand } from './lens-commands.ts'

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

test('lens set adds and changes a lens including requires-execution', () => {
  const output: string[] = []
  const presentation = { log: (value: string) => output.push(value) }
  lensCommand(setCommand('First title', false), presentation)
  lensCommand(setCommand('Changed title', true), presentation)

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
