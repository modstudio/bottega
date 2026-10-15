import { expect, test } from 'bun:test'
import type { CommandRoute } from '../cli/routes.ts'
// The hub program imports without opening a store; the orchestrator program resolves its store at import.
import { program as commanderFactory } from '../hub/src/cli-program.ts'
import { PLATFORM_SLUG } from '../shared/brand.ts'
import {
  descriptionBaselineFailures,
  descriptionFindings,
  documentationUnits,
} from './command-descriptions.ts'

const groups = [['run', 'dispatch and inspect runs']] as const

function fixture(description = 'show one run') {
  const orch = commanderFactory.createCommand('orch')
  orch
    .command('show')
    .description(description)
    .option('--format <name>', 'select the output format')
  return {
    programs: { orch, hub: commanderFactory.createCommand('hub') },
    routes: [{ command: ['run', 'show'], owner: 'orch', argv: ['show'] }] satisfies CommandRoute[],
  }
}

test('a described command and its visible options pass', () => {
  const { programs, routes } = fixture()
  expect(descriptionFindings(documentationUnits(groups, routes, programs))).toEqual([])
})

test('a missing owner description is named with its front-door spelling', () => {
  const { programs, routes } = fixture('')
  expect(descriptionFindings(documentationUnits(groups, routes, programs))).toContainEqual({
    kind: 'command',
    spelling: `${PLATFORM_SLUG} run show`,
    group: 'run',
    source: 'orchestrator/src/cli/program.ts',
  })
})

test('nested visible subcommands and their descriptions use the front-door spelling', () => {
  const { programs, routes } = fixture()
  programs.orch.commands[0]!.command('details').description('show run details')
  programs.orch.commands[0]!.command('events')
  programs.orch.commands[0]!.command('internal', { hidden: true })

  const findings = descriptionFindings(documentationUnits(groups, routes, programs))
  expect(findings).not.toContainEqual(
    expect.objectContaining({ spelling: `${PLATFORM_SLUG} run show details` }),
  )
  expect(findings).toContainEqual({
    kind: 'command',
    spelling: `${PLATFORM_SLUG} run show events`,
    group: 'run',
    source: 'orchestrator/src/cli/program.ts',
  })
  expect(findings).not.toContainEqual(
    expect.objectContaining({ spelling: `${PLATFORM_SLUG} run show internal` }),
  )
})

test('hidden routes and hidden owner commands are exempt', () => {
  const programs = {
    orch: commanderFactory.createCommand('orch'),
    hub: commanderFactory.createCommand('hub'),
  }
  programs.orch.command('secret', { hidden: true })
  const routes = [
    { command: ['run', 'hidden-route'], owner: 'orch', argv: ['missing'], hidden: true },
    { command: ['run', 'hidden-owner'], owner: 'orch', argv: ['secret'] },
  ] satisfies CommandRoute[]
  expect(descriptionFindings(documentationUnits(groups, routes, programs))).toEqual([])
})

test('a stale baseline entry fails with the regenerate command', () => {
  expect(descriptionBaselineFailures([], ['run show'])).toEqual([
    `${PLATFORM_SLUG} run show: stale baseline entry; run bun scripts/check-command-descriptions.ts --write-baseline`,
  ])
})
