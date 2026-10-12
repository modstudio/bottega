// concern: enforcement-commands
/** Reads registered projects and presents their resolved mechanical enforcement. */

import { type Project, projectAt, projectByName, projects } from '../project/projects.ts'
import { type ResolvedMechanicalCheck, resolveMechanicalChecks } from './enforcement-resolution.ts'

type EnforcementReport = {
  project: string
  rows: ResolvedMechanicalCheck[]
  remoteRequiredChecks: string[]
}

type EnforcementOptions = {
  project?: string
  all?: boolean
  json?: boolean
}

type EnforcementPresentation = {
  log(value: string): void
  error(value: string): void
  setExitCode(code: number): void
  cwd(): string
}

type EnforcementDependencies = {
  projects: typeof projects
  projectByName: typeof projectByName
  projectAt: typeof projectAt
}

const dependencies: EnforcementDependencies = { projects, projectByName, projectAt }

function report(project: Project): EnforcementReport {
  return {
    project: project.name,
    rows: resolveMechanicalChecks({ stack: project.stack, settings: project.settings }),
    remoteRequiredChecks: project.settings.release?.requiredChecks ?? [],
  }
}

function selectedProjects(
  options: EnforcementOptions,
  cwd: string,
  deps: EnforcementDependencies,
): Project[] {
  if (options.all && options.project) throw new Error('choose only one of --project or --all')
  if (options.all) return deps.projects()
  if (options.project) {
    const selected = deps.projectByName(options.project)
    if (!selected) throw new Error(`project "${options.project}" is not registered`)
    return [selected]
  }
  const selected = deps.projectAt(cwd)
  if (!selected) {
    throw new Error(`no registered project contains ${cwd}; pass --project <name> or --all`)
  }
  return [selected]
}

function textTable(rows: ResolvedMechanicalCheck[]): string[] {
  const headings = [
    'category',
    'title',
    'scope',
    'tool',
    'points',
    'blocking',
    'limit',
    'source',
    'note',
    'reason',
  ]
  const values = rows.map((row) => [
    row.category,
    row.title,
    row.scope,
    row.tool ?? '—',
    row.points.join(', '),
    row.blocking ? 'yes' : 'no',
    row.limit === null ? '—' : String(row.limit),
    row.source,
    row.note ?? '—',
    row.reason ?? '—',
  ])
  const widths = headings.map((heading, index) =>
    Math.max(heading.length, ...values.map((value) => value[index]!.length)),
  )
  const line = (cells: string[]) =>
    cells
      .map((cell, index) => cell.padEnd(widths[index]!))
      .join('  ')
      .trimEnd()
  return [line(headings), line(widths.map((width) => '-'.repeat(width))), ...values.map(line)]
}

function printReport(value: EnforcementReport, presentation: EnforcementPresentation): void {
  presentation.log(value.project)
  for (const line of textTable(value.rows)) presentation.log(line)
  presentation.log('remote required checks')
  if (!value.remoteRequiredChecks.length) presentation.log('(none)')
  for (const check of value.remoteRequiredChecks) presentation.log(`- ${check}`)
}

export function enforcementCommand(
  options: EnforcementOptions,
  presentation: EnforcementPresentation,
  deps: EnforcementDependencies = dependencies,
): void {
  try {
    const reports = selectedProjects(options, presentation.cwd(), deps).map(report)
    if (options.json) {
      presentation.log(JSON.stringify({ projects: reports }))
      return
    }
    reports.forEach((value, index) => {
      if (index) presentation.log('')
      printReport(value, presentation)
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (options.json) presentation.log(JSON.stringify({ error: message }))
    else presentation.error(message)
    presentation.setExitCode(1)
  }
}
