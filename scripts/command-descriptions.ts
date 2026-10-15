import type { Command, Option } from 'commander'
import type { CommandRoute } from '../cli/routes.ts'
import { PLATFORM_SLUG } from '../shared/brand.ts'

export type CommandPrograms = Readonly<Record<'orch' | 'hub', Command>>
export type CommandGroup = readonly [name: string, description: string]

export type DocumentationUnit = {
  kind: 'command' | 'option'
  spelling: string
  group: string
  description: string
  source: 'cli/routes.ts' | 'orchestrator/src/cli/program.ts' | 'hub/src/cli-program.ts'
}

export type DocumentationInventory = {
  units: DocumentationUnit[]
  notWalked: string[]
}

export type DescriptionFinding = Pick<DocumentationUnit, 'kind' | 'spelling' | 'group' | 'source'>

const ownerSource = (owner: 'orch' | 'hub') =>
  owner === 'orch' ? 'orchestrator/src/cli/program.ts' : 'hub/src/cli-program.ts'

function commandAt(program: Command, path: readonly string[]): Command | null {
  let command = program
  for (const name of path) {
    const next = command.commands.find(
      (candidate) => candidate.name() === name || candidate.aliases().includes(name),
    )
    if (!next) return null
    command = next
  }
  return command
}

function optionName(option: Option): string {
  return option.long ?? option.short ?? option.flags
}

function optionUnits(
  spelling: string,
  group: string,
  command: Command,
  source: DocumentationUnit['source'],
  exposed?: Readonly<Record<string, boolean>>,
): DocumentationUnit[] {
  return command
    .createHelp()
    .visibleOptions(command)
    .filter((option) => exposed === undefined || exposed[optionName(option)] !== undefined)
    .map((option) => ({
      kind: 'option',
      spelling: `${spelling} ${optionName(option)}`,
      group,
      description: option.description,
      source,
    }))
}

function routeOptionName(flags: string): string {
  return flags.split(/[ ,|]+/).find((part) => part.startsWith('--')) ?? flags.split(/\s+/)[0]!
}

function declaredOptionUnits(route: CommandRoute, spelling: string): DocumentationUnit[] {
  return (route.options ?? []).map((option) => ({
    kind: 'option',
    spelling: `${spelling} ${routeOptionName(option.flags)}`,
    group: route.command[0]!,
    description: option.description,
    source: 'cli/routes.ts',
  }))
}

function routeSpelling(route: CommandRoute): string {
  return `${PLATFORM_SLUG} ${route.command.join(' ')}`
}

function resolutionError(
  route: CommandRoute,
  owner: 'orch' | 'hub',
  argv: readonly string[],
): Error {
  return new Error(
    `${routeSpelling(route)}: cannot resolve visible route owner ${owner} argv ${JSON.stringify(argv)}`,
  )
}

function resolveOwnerCommand(
  route: CommandRoute,
  owner: 'orch' | 'hub',
  argv: readonly string[],
  programs: CommandPrograms,
): Command {
  const command = commandAt(programs[owner], argv)
  if (!command) throw resolutionError(route, owner, argv)
  return command
}

function routeCommandUnit(
  route: CommandRoute,
  description: string,
  source: DocumentationUnit['source'],
): DocumentationUnit {
  return {
    kind: 'command',
    spelling: routeSpelling(route),
    group: route.command[0]!,
    description,
    source,
  }
}

function isArgsStyle(command: Command): boolean {
  return (
    command.commands.length === 0 &&
    command.registeredArguments.some((argument) => argument.variadic)
  )
}

function compositeRouteUnits(route: CommandRoute, programs: CommandPrograms): DocumentationUnit[] {
  const commandUnit = routeCommandUnit(route, route.description ?? '', 'cli/routes.ts')
  const optionDocumentation = (route.composite ?? []).flatMap((part) => {
    const command = resolveOwnerCommand(route, part.owner, part.argv, programs)
    return optionUnits(
      commandUnit.spelling,
      commandUnit.group,
      command,
      ownerSource(part.owner),
      part.options,
    )
  })
  return [commandUnit, ...optionDocumentation]
}

function outboxRouteUnits(route: CommandRoute, programs: CommandPrograms): DocumentationUnit[] {
  const spelling = routeSpelling(route)
  const units = [
    routeCommandUnit(route, route.description ?? '', 'cli/routes.ts'),
    ...declaredOptionUnits(route, spelling),
  ]
  const orch = resolveOwnerCommand(route, 'orch', ['record', 'outbox'], programs)
  const hub = resolveOwnerCommand(route, 'hub', ['outbox'], programs)
  const orchVerbs = new Map(
    orch
      .createHelp()
      .visibleCommands(orch)
      .map((command) => [command.name(), command]),
  )
  const hubVerbs = new Map(
    hub
      .createHelp()
      .visibleCommands(hub)
      .map((command) => [command.name(), command]),
  )
  const verbNames = new Set([...orchVerbs.keys(), ...hubVerbs.keys()])
  for (const name of [...verbNames].sort()) {
    const orchVerb = orchVerbs.get(name)
    const hubVerb = hubVerbs.get(name)
    const selected = orchVerb ?? hubVerb!
    const description = orchVerb?.description().trim()
      ? orchVerb.description()
      : (hubVerb?.description() ?? orchVerb?.description() ?? '')
    const sourceOwner = orchVerb ? 'orch' : 'hub'
    const verbSpelling = `${spelling} ${name}`
    units.push(
      {
        kind: 'command',
        spelling: verbSpelling,
        group: route.command[0]!,
        description,
        source: ownerSource(sourceOwner),
      },
      ...optionUnits(verbSpelling, route.command[0]!, selected, ownerSource(sourceOwner)),
    )
  }
  return units
}

function ownerRouteUnits(
  route: CommandRoute,
  programs: CommandPrograms,
  routedSpellings: ReadonlySet<string>,
  notWalked: Set<string>,
): DocumentationUnit[] {
  if (route.owner !== 'orch' && route.owner !== 'hub') return []
  const command = resolveOwnerCommand(route, route.owner, route.argv ?? [], programs)
  const spelling = routeSpelling(route)
  const group = route.command[0]!
  const source = ownerSource(route.owner)
  const units = optionUnits(spelling, group, command, source)
  if (route.command.length > 1) {
    units.unshift(
      routeCommandUnit(
        route,
        route.description === undefined ? command.description() : route.description,
        route.description === undefined ? source : 'cli/routes.ts',
      ),
    )
  }

  function appendSubcommands(parent: Command, parentSpelling: string) {
    if (isArgsStyle(parent)) notWalked.add(parentSpelling)
    for (const subcommand of parent.createHelp().visibleCommands(parent)) {
      const subcommandSpelling = `${parentSpelling} ${subcommand.name()}`
      if (routedSpellings.has(subcommandSpelling)) continue
      units.push(
        {
          kind: 'command',
          spelling: subcommandSpelling,
          group,
          description: subcommand.description(),
          source,
        },
        ...optionUnits(subcommandSpelling, group, subcommand, source),
      )
      appendSubcommands(subcommand, subcommandSpelling)
    }
  }

  appendSubcommands(command, spelling)
  return units
}

function routeUnits(
  route: CommandRoute,
  programs: CommandPrograms,
  routedSpellings: ReadonlySet<string>,
  notWalked: Set<string>,
): DocumentationUnit[] {
  if (route.hidden) return []
  if (route.owner === 'composite') return compositeRouteUnits(route, programs)
  if (route.owner === 'outbox') return outboxRouteUnits(route, programs)
  if (route.owner === 'local') {
    const spelling = routeSpelling(route)
    return [
      routeCommandUnit(route, route.description ?? '', 'cli/routes.ts'),
      ...declaredOptionUnits(route, spelling),
    ]
  }
  return ownerRouteUnits(route, programs, routedSpellings, notWalked)
}

export function documentationInventory(
  groups: readonly CommandGroup[],
  routes: readonly CommandRoute[],
  programs: CommandPrograms,
): DocumentationInventory {
  const units: DocumentationUnit[] = groups.map(([group, description]) => ({
    kind: 'command',
    spelling: `${PLATFORM_SLUG} ${group}`,
    group,
    description,
    source: 'cli/routes.ts',
  }))
  const routedSpellings = new Set(
    routes.filter((route) => !route.hidden).map((route) => routeSpelling(route)),
  )
  const notWalked = new Set<string>()
  for (const route of routes) units.push(...routeUnits(route, programs, routedSpellings, notWalked))

  const unique = new Map<string, DocumentationUnit>()
  for (const unit of units) {
    const key = `${unit.kind}\0${unit.spelling}`
    const previous = unique.get(key)
    if (previous) {
      throw new Error(
        `${unit.spelling}: duplicate ${unit.kind} documentation from ${previous.source} and ${unit.source}`,
      )
    }
    unique.set(key, unit)
  }
  return {
    units: [...unique.values()].sort(
      (left, right) =>
        left.spelling.localeCompare(right.spelling) || left.kind.localeCompare(right.kind),
    ),
    notWalked: [...notWalked].sort(),
  }
}

export function descriptionFindings(units: readonly DocumentationUnit[]): DescriptionFinding[] {
  return units
    .filter((unit) => unit.description.trim() === '')
    .map(({ kind, spelling, group, source }) => ({ kind, spelling, group, source }))
}

export function descriptionBaselineFailures(
  findings: readonly DescriptionFinding[],
  baseline: readonly string[],
): string[] {
  const current = new Map(findings.map((finding) => [finding.spelling, finding]))
  const expected = new Set(baseline.map((entry) => `${PLATFORM_SLUG} ${entry}`))
  const failures: string[] = []
  for (const finding of findings) {
    if (!expected.has(finding.spelling)) {
      failures.push(`${finding.spelling}: missing description; edit ${finding.source}`)
    }
  }
  for (const entry of baseline) {
    const spelling = `${PLATFORM_SLUG} ${entry}`
    if (!current.has(spelling)) {
      failures.push(
        `${spelling}: stale baseline entry; run bun scripts/check-command-descriptions.ts --write-baseline`,
      )
    }
  }
  return failures
}
