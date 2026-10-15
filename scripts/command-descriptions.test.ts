import { expect, test } from 'bun:test'
import type { CommandRoute } from '../cli/routes.ts'
import { program as commanderFactory } from '../orchestrator/src/cli/program.ts'
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
