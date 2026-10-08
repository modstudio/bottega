import { expect, test } from 'bun:test'
import { Command } from 'commander'
import { assertUserCanonHydrateAllowed, register } from './docs.ts'

const flags = (...names: string[]) => ({ has: (name: string) => names.includes(name) })

function parseDocOptions(argv: string[]) {
  const program = new Command().exitOverride()
  register(program)
  const command = program.commands.find((candidate) => candidate.name() === 'doc')!
  const parsed = command.parseOptions(argv)
  return { parsed, options: command.opts() }
}

test('the registered doc command parses status, set, and filtered list lifecycle flags', () => {
  expect(
    parseDocOptions([
      'status',
      'guide',
      '--scope',
      'global',
      '--status',
      'superseded',
      '--replacement',
      'new-guide',
    ]),
  ).toMatchObject({
    parsed: { operands: ['status', 'guide'], unknown: [] },
    options: { scope: 'global', status: 'superseded', replacement: 'new-guide' },
  })
  expect(parseDocOptions(['set', 'guide', '--scope', 'global', '--status', 'draft'])).toMatchObject(
    {
      parsed: { operands: ['set', 'guide'], unknown: [] },
      options: { scope: 'global', status: 'draft' },
    },
  )
  expect(parseDocOptions(['list', '--status', 'archived'])).toMatchObject({
    parsed: { operands: ['list'], unknown: [] },
    options: { status: 'archived' },
  })
})

test('an orch worker cannot hydrate user canon but can check it', () => {
  const inventory = {
    ascertainable: true as const,
    rows: [
      { pid: 100, ppid: 1, pgid: 100, command: 'bun orchestrator/src/run/exec.ts 6731 prompt job' },
      { pid: 200, ppid: 100, pgid: 100, command: 'codex worker' },
      { pid: 300, ppid: 200, pgid: 100, command: 'orch canon hydrate --user' },
    ],
  }

  expect(() => assertUserCanonHydrateAllowed(flags(), {}, 300, inventory)).toThrow(
    'refusing user canon hydrate from an orch worker run; an operator must run orch canon hydrate --user',
  )
  expect(() => assertUserCanonHydrateAllowed(flags('check'), {}, 300, inventory)).not.toThrow()
})
