import type { CommandRoute } from '../cli/routes.ts'
import type { program as OrchProgram } from '../orchestrator/src/cli/program.ts'
import { PLATFORM_SLUG } from '../shared/brand.ts'

type Command = typeof OrchProgram
type CommandOption = ReturnType<ReturnType<Command['createHelp']>['visibleOptions']>[number]

export type CommandPrograms = Readonly<Record<'orch' | 'hub', Command>>
export type CommandGroup = readonly [name: string, description: string]

export type DocumentationUnit = {
  kind: 'command' | 'option'
  spelling: string
  group: string
  description: string
  source: 'cli/routes.ts' | 'orchestrator/src/cli/program.ts' | 'hub/src/cli-program.ts'
}

export type DescriptionFinding = Pick<DocumentationUnit, 'kind' | 'spelling' | 'group' | 'source'>

const ownerSource = (owner: 'orch' | 'hub') =>
  owner === 'orch' ? 'orchestrator/src/cli/program.ts' : 'hub/src/cli-program.ts'

function visibleCommandAt(program: Command, path: readonly string[]): Command | null {
  let command = program
  for (const name of path) {
    const next = command
      .createHelp()
      .visibleCommands(command)
      .find((candidate) => candidate.name() === name || candidate.aliases().includes(name))
    if (!next) return null
    command = next
  }
  return command
}

function optionName(option: CommandOption): string {
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

function ownerCommand(owner: 'orch' | 'hub', argv: readonly string[], programs: CommandPrograms) {
  return visibleCommandAt(programs[owner], argv)
}

function routeCommandUnit(
  route: CommandRoute,
  description: string,
  source: DocumentationUnit['source'],
): DocumentationUnit {
  return {
    kind: 'command',
    spelling: `${PLATFORM_SLUG} ${route.command.join(' ')}`,
    group: route.command[0]!,
    description,
    source,
  }
}

function compositeRouteUnits(route: CommandRoute, programs: CommandPrograms): DocumentationUnit[] {
  const commandUnit = routeCommandUnit(route, route.description ?? '', 'cli/routes.ts')
  const optionDocumentation = (route.composite ?? []).flatMap((part) => {
    const command = ownerCommand(part.owner, part.argv, programs)
    return command
      ? optionUnits(
          commandUnit.spelling,
          commandUnit.group,
          command,
          ownerSource(part.owner),
          part.options,
        )
      : []
  })
  return [commandUnit, ...optionDocumentation]
}

function ownerRouteUnits(route: CommandRoute, programs: CommandPrograms): DocumentationUnit[] {
  if (route.owner !== 'orch' && route.owner !== 'hub') return []
  const command = ownerCommand(route.owner, route.argv ?? [], programs)
  if (!command) return []
  const spelling = `${PLATFORM_SLUG} ${route.command.join(' ')}`
  const group = route.command[0]!
  const options = optionUnits(spelling, group, command, ownerSource(route.owner))
  return route.command.length > 1
    ? [routeCommandUnit(route, command.description(), ownerSource(route.owner)), ...options]
    : options
}

function routeUnits(route: CommandRoute, programs: CommandPrograms): DocumentationUnit[] {
  if (route.hidden) return []
  if (route.owner === 'composite') return compositeRouteUnits(route, programs)
  if (route.owner === 'local' || route.owner === 'outbox') {
    return [routeCommandUnit(route, route.description ?? '', 'cli/routes.ts')]
  }
  return ownerRouteUnits(route, programs)
}

export function documentationUnits(
  groups: readonly CommandGroup[],
  routes: readonly CommandRoute[],
  programs: CommandPrograms,
): DocumentationUnit[] {
  const units: DocumentationUnit[] = groups.map(([group, description]) => ({
    kind: 'command',
    spelling: `${PLATFORM_SLUG} ${group}`,
    group,
    description,
    source: 'cli/routes.ts',
  }))

  for (const route of routes) units.push(...routeUnits(route, programs))

  const unique = new Map(units.map((unit) => [`${unit.kind}\0${unit.spelling}`, unit]))
  return [...unique.values()].sort(
    (left, right) =>
      left.spelling.localeCompare(right.spelling) || left.kind.localeCompare(right.kind),
  )
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
