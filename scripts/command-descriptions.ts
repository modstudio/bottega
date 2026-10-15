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
  groups: DocumentationGroup[]
  commands: DocumentationCommand[]
}

export type DocumentationGroup = {
  name: string
  description: string
}

export type DocumentationArgument = {
  name: string
  required: boolean
  variadic: boolean
}

export type DocumentationOptionDefault =
  | { kind: 'literal'; text: string }
  | { kind: 'cwd' }
  | { kind: 'env'; name: string }

export type DocumentationOptionDetail = {
  flags: string
  valuePlaceholder: string | null
  description: string
  default: DocumentationOptionDefault | null
}

export type DocumentationCommand = {
  spelling: string
  group: string
  description: string
  arguments: DocumentationArgument[]
  options: DocumentationOptionDetail[]
  examples: string[]
  optionsByHelp: boolean
}

export type DescriptionFinding = Pick<DocumentationUnit, 'kind' | 'spelling' | 'group' | 'source'>

type CommandBook = Map<string, DocumentationCommand>

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

function valuePlaceholder(flags: string): string | null {
  const match = flags.match(/<[^>]+>|\[[^\]]+\]/)
  return match ? match[0] : null
}

function optionDefault(option: Option): DocumentationOptionDefault | null {
  if (option.envVar) return { kind: 'env', name: option.envVar }
  if (option.defaultValueDescription)
    return { kind: 'literal', text: option.defaultValueDescription }
  if (option.defaultValue === undefined) return null
  if (typeof option.defaultValue === 'string' && option.defaultValue === process.cwd()) {
    return { kind: 'cwd' }
  }
  if (
    typeof option.defaultValue === 'string' ||
    typeof option.defaultValue === 'number' ||
    typeof option.defaultValue === 'boolean'
  ) {
    return { kind: 'literal', text: String(option.defaultValue) }
  }
  if (
    Array.isArray(option.defaultValue) &&
    option.defaultValue.every(
      (value) =>
        typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean',
    )
  ) {
    return { kind: 'literal', text: option.defaultValue.map(String).join(', ') }
  }
  return { kind: 'literal', text: 'the declared default' }
}

function optionDetail(option: Option): DocumentationOptionDetail {
  return {
    flags: option.flags,
    valuePlaceholder: valuePlaceholder(option.flags),
    description: option.description,
    default: optionDefault(option),
  }
}

function declaredOptionDetail(flags: string, description: string): DocumentationOptionDetail {
  return {
    flags,
    valuePlaceholder: valuePlaceholder(flags),
    description,
    default: null,
  }
}

function argumentDetails(command: Command): DocumentationArgument[] {
  return command.registeredArguments.map((argument) => ({
    name: argument.name(),
    required: argument.required,
    variadic: argument.variadic,
  }))
}

function visibleOptionDetails(
  command: Command,
  exposed?: Readonly<Record<string, boolean>>,
): DocumentationOptionDetail[] {
  return command
    .createHelp()
    .visibleOptions(command)
    .filter((option) => exposed === undefined || exposed[optionName(option)] !== undefined)
    .map(optionDetail)
}

function writeCommand(book: CommandBook, command: DocumentationCommand): DocumentationCommand {
  const previous = book.get(command.spelling)
  if (!previous) {
    book.set(command.spelling, command)
    return command
  }
  if (!previous.description) previous.description = command.description
  if (previous.arguments.length === 0) previous.arguments = command.arguments
  if (!previous.optionsByHelp) previous.options.push(...command.options)
  if (command.optionsByHelp) {
    previous.optionsByHelp = true
    previous.options = []
  }
  if (previous.examples.length === 0) previous.examples = command.examples
  return previous
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

function compositeRouteUnits(
  route: CommandRoute,
  programs: CommandPrograms,
  book: CommandBook,
): DocumentationUnit[] {
  const commandUnit = routeCommandUnit(route, route.description ?? '', 'cli/routes.ts')
  const options = (route.composite ?? []).flatMap((part) => {
    const command = resolveOwnerCommand(route, part.owner, part.argv, programs)
    return visibleOptionDetails(command, part.options)
  })
  writeCommand(book, {
    spelling: commandUnit.spelling,
    group: commandUnit.group,
    description: commandUnit.description,
    arguments: [],
    options,
    examples: [],
    optionsByHelp: false,
  })
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

function outboxRouteUnits(
  route: CommandRoute,
  programs: CommandPrograms,
  book: CommandBook,
): DocumentationUnit[] {
  const spelling = routeSpelling(route)
  const parent = routeCommandUnit(route, route.description ?? '', 'cli/routes.ts')
  writeCommand(book, {
    spelling,
    group: parent.group,
    description: parent.description,
    arguments: [],
    options: (route.options ?? []).map((option) =>
      declaredOptionDetail(option.flags, option.description),
    ),
    examples: [],
    optionsByHelp: false,
  })
  const units = [parent, ...declaredOptionUnits(route, spelling)]
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
    writeCommand(book, {
      spelling: verbSpelling,
      group: route.command[0]!,
      description,
      arguments: argumentDetails(selected),
      options: visibleOptionDetails(selected),
      examples: [],
      optionsByHelp: false,
    })
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
  book: CommandBook,
): DocumentationUnit[] {
  if (route.owner !== 'orch' && route.owner !== 'hub') return []
  const command = resolveOwnerCommand(route, route.owner, route.argv ?? [], programs)
  const spelling = routeSpelling(route)
  const group = route.command[0]!
  const source = ownerSource(route.owner)
  const units = optionUnits(spelling, group, command, source)
  if (route.command.length > 1) {
    const commandUnit = routeCommandUnit(
      route,
      route.description === undefined ? command.description() : route.description,
      route.description === undefined ? source : 'cli/routes.ts',
    )
    units.unshift(commandUnit)
    writeCommand(book, {
      spelling,
      group,
      description: commandUnit.description,
      arguments: argumentDetails(command),
      options: isArgsStyle(command) ? [] : visibleOptionDetails(command),
      examples: [],
      optionsByHelp: isArgsStyle(command),
    })
  } else {
    writeCommand(book, {
      spelling,
      group,
      description: route.description === undefined ? command.description() : route.description,
      arguments: argumentDetails(command),
      options: isArgsStyle(command) ? [] : visibleOptionDetails(command),
      examples: [],
      optionsByHelp: isArgsStyle(command),
    })
  }

  function appendSubcommands(parent: Command, parentSpelling: string) {
    if (isArgsStyle(parent)) notWalked.add(parentSpelling)
    for (const subcommand of parent.createHelp().visibleCommands(parent)) {
      const subcommandSpelling = `${parentSpelling} ${subcommand.name()}`
      if (routedSpellings.has(subcommandSpelling)) continue
      const argsStyle = isArgsStyle(subcommand)
      writeCommand(book, {
        spelling: subcommandSpelling,
        group,
        description: subcommand.description(),
        arguments: argumentDetails(subcommand),
        options: argsStyle ? [] : visibleOptionDetails(subcommand),
        examples: [],
        optionsByHelp: argsStyle,
      })
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
  book: CommandBook,
): DocumentationUnit[] {
  if (route.hidden) return []
  if (route.owner === 'composite') return compositeRouteUnits(route, programs, book)
  if (route.owner === 'outbox') return outboxRouteUnits(route, programs, book)
  if (route.owner === 'local') {
    const spelling = routeSpelling(route)
    const commandUnit = routeCommandUnit(route, route.description ?? '', 'cli/routes.ts')
    writeCommand(book, {
      spelling,
      group: commandUnit.group,
      description: commandUnit.description,
      arguments: [],
      options: (route.options ?? []).map((option) =>
        declaredOptionDetail(option.flags, option.description),
      ),
      examples: [],
      optionsByHelp: false,
    })
    return [commandUnit, ...declaredOptionUnits(route, spelling)]
  }
  return ownerRouteUnits(route, programs, routedSpellings, notWalked, book)
}

export function documentationInventory(
  groups: readonly CommandGroup[],
  routes: readonly CommandRoute[],
  programs: CommandPrograms,
): DocumentationInventory {
  const book: CommandBook = new Map()
  const units: DocumentationUnit[] = groups.map(([group, description]) => {
    const spelling = `${PLATFORM_SLUG} ${group}`
    writeCommand(book, {
      spelling,
      group,
      description,
      arguments: [],
      options: [],
      examples: [],
      optionsByHelp: false,
    })
    return {
      kind: 'command',
      spelling,
      group,
      description,
      source: 'cli/routes.ts',
    }
  })
  const routedSpellings = new Set(
    routes.filter((route) => !route.hidden).map((route) => routeSpelling(route)),
  )
  const notWalked = new Set<string>()
  for (const route of routes)
    units.push(...routeUnits(route, programs, routedSpellings, notWalked, book))

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
  for (const spelling of notWalked) {
    const command = book.get(spelling)
    if (!command) continue
    command.optionsByHelp = true
    command.options = []
  }
  return {
    units: [...unique.values()].sort(
      (left, right) =>
        left.spelling.localeCompare(right.spelling) || left.kind.localeCompare(right.kind),
    ),
    notWalked: [...notWalked].sort(),
    groups: groups.map(([name, description]) => ({ name, description })),
    commands: [...book.values()].sort((left, right) => left.spelling.localeCompare(right.spelling)),
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
