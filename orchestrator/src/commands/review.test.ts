import { expect, test } from 'bun:test'
import { Command } from 'commander'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { register } from './review.ts'

const CLEAR_USAGE = `${PLATFORM_SLUG} review confinement clear <run-id> --writer <text> --note <text> [--tip <current-tip>]`

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

test('review subcommands refuse unknown options inherited from the review group', async () => {
  const program = new Command().exitOverride()
  register(program)

  await expect(
    program.parseAsync(['node', 'orch', 'review', 'list', '--cwd', '/tmp/other-tree']),
  ).rejects.toThrow("unknown option '--cwd'")
})

test('confinement clear without --writer or --note still prints the clear usage', async () => {
  const recordId = addRun({ agent: 'codex', job: 'implement', status: 'ok' })
  const number = (
    db().query('SELECT number FROM run WHERE record_id=?').get(recordId) as {
      number: number
    }
  ).number
  const program = confinementProgram()
  await expect(
    program.parseAsync([
      'node',
      'orch',
      'confinement',
      'clear',
      String(number),
      '--writer',
      'architect',
    ]),
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
