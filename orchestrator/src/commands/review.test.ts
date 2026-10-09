import { expect, test } from 'bun:test'
import { Command } from 'commander'
import { register } from './review.ts'

const CLEAR_USAGE =
  'orch confinement clear <run-id> --writer <text> --note <text> [--tip <current-tip>]'

function confinementProgram(): Command {
  const program = new Command().exitOverride()
  register(program)
  return program
}

test('confinement clear rejects --agent, --job, --mcp, and --json', async () => {
  const extras = [['--json'], ['--agent', 'grok'], ['--job', 'reading'], ['--mcp']] as const
  for (const extra of extras) {
    const program = confinementProgram()
    await expect(
      program.parseAsync([
        'node',
        'orch',
        'confinement',
        'clear',
        '1',
        '--writer',
        'architect',
        '--note',
        'restore',
        ...extra,
      ]),
    ).rejects.toThrow(/unknown option/)
  }
})

test('confinement clear without --writer or --note still prints the clear usage', async () => {
  const program = confinementProgram()
  await expect(
    program.parseAsync(['node', 'orch', 'confinement', 'clear', '1', '--writer', 'architect']),
  ).rejects.toThrow(CLEAR_USAGE)
})

test('confinement report accepts --agent, --job, --mcp, and --json without executing the report', () => {
  const program = confinementProgram()
  const confinement = program.commands.find((command) => command.name() === 'confinement')!
  const report = confinement.commands.find((command) => command.name() === 'report')!
  const parsed = report.parseOptions([
    '--json',
    '--agent',
    'grok',
    '--job',
    'reading',
    '--mcp',
    'false',
  ])
  expect(parsed.unknown).toEqual([])
  expect(report.opts()).toMatchObject({
    json: true,
    agent: 'grok',
    job: 'reading',
    mcp: 'false',
  })
})
