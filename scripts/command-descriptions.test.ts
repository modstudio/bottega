import { expect, test } from 'bun:test'
import { Command } from 'commander'
import type { CommandRoute } from '../cli/routes.ts'
import { PLATFORM_SLUG } from '../shared/brand.ts'
import {
  descriptionBaselineFailures,
  descriptionFindings,
  documentationInventory,
} from './command-descriptions.ts'

const groups = [['run', 'dispatch and inspect runs']] as const

function programs() {
  return { orch: new Command('orch'), hub: new Command('hub') }
}

function fixture(description = 'show one run') {
  const commandPrograms = programs()
  commandPrograms.orch
    .command('show')
    .description(description)
    .option('--format <name>', 'select the output format')
  return {
    programs: commandPrograms,
    routes: [{ command: ['run', 'show'], owner: 'orch', argv: ['show'] }] satisfies CommandRoute[],
  }
}

test('a described command and its visible options pass', () => {
  const { programs: commandPrograms, routes } = fixture()
  expect(
    descriptionFindings(documentationInventory(groups, routes, commandPrograms).units),
  ).toEqual([])
})

test('a missing owner description is named with its front-door spelling', () => {
  const { programs: commandPrograms, routes } = fixture('')
  expect(
    descriptionFindings(documentationInventory(groups, routes, commandPrograms).units),
  ).toContainEqual({
    kind: 'command',
    spelling: `${PLATFORM_SLUG} run show`,
    group: 'run',
    source: 'orchestrator/src/cli/program.ts',
  })
})

test('nested visible subcommands and their descriptions use the front-door spelling', () => {
  const { programs: commandPrograms, routes } = fixture()
  commandPrograms.orch.commands[0]!.command('details').description('show run details')
  commandPrograms.orch.commands[0]!.command('events')
  commandPrograms.orch.commands[0]!.command('internal', { hidden: true })

  const findings = descriptionFindings(
    documentationInventory(groups, routes, commandPrograms).units,
  )
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

test('an unresolved visible route fails closed with its owner and argv', () => {
  const commandPrograms = programs()
  const routes = [
    { command: ['run', 'missing'], owner: 'orch', argv: ['renamed'] },
  ] satisfies CommandRoute[]
  expect(() => documentationInventory(groups, routes, commandPrograms)).toThrow(
    `${PLATFORM_SLUG} run missing: cannot resolve visible route owner orchestrator argv ["renamed"]`,
  )
})

test('an unresolved composite part fails closed with its owner and argv', () => {
  const commandPrograms = programs()
  commandPrograms.orch.command('sync')
  const routes = [
    {
      command: ['run', 'sync'],
      owner: 'composite',
      description: 'sync both stores',
      composite: [
        { owner: 'orch', argv: ['sync'], label: 'orch' },
        { owner: 'hub', argv: ['missing'], label: 'hub' },
      ],
    },
  ] satisfies CommandRoute[]
  expect(() => documentationInventory(groups, routes, commandPrograms)).toThrow(
    `${PLATFORM_SLUG} run sync: cannot resolve visible route owner hub argv ["missing"]`,
  )
})

test('only a hidden route is exempt from owner resolution', () => {
  const routes = [
    { command: ['run', 'internal'], owner: 'orch', argv: ['missing'], hidden: true },
  ] satisfies CommandRoute[]
  expect(documentationInventory(groups, routes, programs()).units).toHaveLength(1)
})

test('owner resolution includes a hidden owner command for a visible route', () => {
  const commandPrograms = programs()
  commandPrograms.orch.command('internal', { hidden: true }).description('supported front door')
  const routes = [
    { command: ['run', 'internal'], owner: 'orch', argv: ['internal'] },
  ] satisfies CommandRoute[]
  expect(
    descriptionFindings(documentationInventory(groups, routes, commandPrograms).units),
  ).toEqual([])
})

test('a specific route overrides the same spelling reached from a generic route', () => {
  const commandPrograms = programs()
  const parent = commandPrograms.orch.command('parent').description('generic route')
  parent.command('details').description('owner description')
  const routes = [
    {
      command: ['run', 'details'],
      owner: 'orch',
      argv: ['parent', 'details'],
      description: 'route description',
    },
    { command: ['run'], owner: 'orch', argv: ['parent'] },
  ] satisfies CommandRoute[]
  const matches = documentationInventory(groups, routes, commandPrograms).units.filter(
    (unit) => unit.spelling === `${PLATFORM_SLUG} run details` && unit.kind === 'command',
  )
  expect(matches).toEqual([
    expect.objectContaining({ description: 'route description', source: 'cli/routes.ts' }),
  ])
})

test('local route options and the outbox owner verb union are documented', () => {
  const commandPrograms = programs()
  const orchOutbox = commandPrograms.orch.command('record').command('outbox')
  orchOutbox.command('retry').description('retry from orch')
  orchOutbox
    .command('retire')
    .description('retire from orch')
    .requiredOption('--reason <text>', 'why')
  const hubOutbox = commandPrograms.hub.command('outbox')
  hubOutbox.command('retry').description('retry from hub')
  hubOutbox.command('show').description('show from hub')
  const routes = [
    {
      command: ['run', 'local'],
      owner: 'local',
      description: 'local report',
      options: [{ flags: '--json', description: 'print JSON' }],
    },
    {
      command: ['run', 'outbox'],
      owner: 'outbox',
      description: 'inspect outbox',
      options: [{ flags: '--json', description: 'print JSON' }],
    },
  ] satisfies CommandRoute[]
  const units = documentationInventory(groups, routes, commandPrograms).units
  expect(units).toContainEqual(
    expect.objectContaining({ spelling: `${PLATFORM_SLUG} run local --json` }),
  )
  expect(units).toContainEqual(
    expect.objectContaining({ spelling: `${PLATFORM_SLUG} run outbox --json` }),
  )
  expect(units).toContainEqual(
    expect.objectContaining({ spelling: `${PLATFORM_SLUG} run outbox retire --reason` }),
  )
  expect(units.filter((unit) => unit.spelling === `${PLATFORM_SLUG} run outbox retry`)).toEqual([
    expect.objectContaining({ description: 'retry from orch' }),
  ])
  expect(units).toContainEqual(
    expect.objectContaining({ spelling: `${PLATFORM_SLUG} run outbox show` }),
  )
})

test('variadic leaf commands are reported as not walked', () => {
  const commandPrograms = programs()
  commandPrograms.orch.command('legacy [args...]').description('legacy dispatcher')
  const routes = [
    { command: ['run', 'legacy'], owner: 'orch', argv: ['legacy'] },
  ] satisfies CommandRoute[]
  expect(documentationInventory(groups, routes, commandPrograms).notWalked).toEqual([
    `${PLATFORM_SLUG} run legacy`,
  ])
})

test('a routed verb inside a variadic owner command resolves to that owner', () => {
  const commandPrograms = programs()
  commandPrograms.orch.command('legacy [args...]').description('legacy dispatcher')
  const routes = [
    { command: ['run', 'show'], owner: 'orch', argv: ['legacy', 'show'] },
  ] satisfies CommandRoute[]

  const inventory = documentationInventory(groups, routes, commandPrograms)
  expect(inventory.notWalked).toEqual([`${PLATFORM_SLUG} run show`])
  expect(inventory.commands).toContainEqual(
    expect.objectContaining({ spelling: `${PLATFORM_SLUG} run show`, optionsByHelp: true }),
  )
})

test('a stale baseline entry fails with the regenerate command', () => {
  expect(descriptionBaselineFailures([], ['run show'])).toEqual([
    `${PLATFORM_SLUG} run show: stale baseline entry; run bun scripts/check-command-descriptions.ts --write-baseline`,
  ])
})

test('an empty default is no default, while a declared value is kept', () => {
  const commandPrograms = programs()
  commandPrograms.orch
    .command('show')
    .description('show one run')
    .option(
      '--id <value>',
      'include this run',
      (value: string, all: string[]) => [...all, value],
      [],
    )
    .option('--label <text>', 'label the run', '')
    .option('--limit <value>', 'limit the rows', '20')
  const routes = [
    { command: ['run', 'show'], owner: 'orch', argv: ['show'] },
  ] satisfies CommandRoute[]
  const command = documentationInventory(groups, routes, commandPrograms).commands.find(
    (entry) => entry.spelling === `${PLATFORM_SLUG} run show`,
  )
  expect(command!.options.slice(0, 3).map((option) => option.default)).toEqual([
    null,
    null,
    { kind: 'literal', text: '20' },
  ])
})
