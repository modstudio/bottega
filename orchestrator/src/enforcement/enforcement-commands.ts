// concern: enforcement-commands
/** Reads registered projects and presents their resolved mechanical enforcement. */

import { type Project, projectAt, projectByName, projects } from '../project/projects.ts'
import { type CategoryExecution, categoryExecutionsForProject } from './enforcement-records.ts'
import { type ResolvedMechanicalCheck, resolveMechanicalChecks } from './enforcement-resolution.ts'

type ReportRow = ResolvedMechanicalCheck & {
  remaining: number | null
  wallMs: number | null
  finishedAt: string | null
}

type EnforcementReport = {
  project: string
  rows: ReportRow[]
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
  categoryExecutionsForProject?: typeof categoryExecutionsForProject
}

const dependencies: EnforcementDependencies = {
  projects,
  projectByName,
  projectAt,
  categoryExecutionsForProject,
}

function observedRow(
  row: ResolvedMechanicalCheck,
  executions: Map<string, CategoryExecution>,
): ReportRow {
  const execution = executions.get(row.category)
  return {
    ...row,
    remaining: execution?.remaining ?? null,
    wallMs: execution?.wallMs ?? null,
    finishedAt: execution?.finishedAt ?? null,
  }
}

function report(project: Project, deps: EnforcementDependencies): EnforcementReport {
  const executions = deps.categoryExecutionsForProject?.(project.path) ?? new Map()
  return {
    project: project.name,
    rows: resolveMechanicalChecks({ stack: project.stack, settings: project.settings }).map((row) =>
      observedRow(row, executions),
    ),
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

function textTable(rows: ReportRow[]): string[] {
  const headings = [
    'category',
    'enforced',
    'title',
    'scope',
    'tool',
    'points',
    'blocking',
    'limit',
    'remaining',
    'time',
    'source',
    'note',
    'reason',
  ]
  const values = rows.map((row) => {
    const standard = !row.enforced && (row.source === 'default' || row.source === 'stack')
    const absent = ['uncovered', 'opted-out', 'not-applicable'].includes(row.source)
    const field = (value: string) => (standard ? `[${value}]` : value)
    return [
      row.category,
      row.enforced ? 'yes' : 'no',
      row.title,
      row.scope,
      field(absent ? '—' : (row.tool ?? '—')),
      field(absent ? '—' : row.points.join(', ')),
      field(absent ? '—' : row.blocking ? 'yes' : 'no'),
      field(absent ? '—' : row.limit === null ? '—' : String(row.limit)),
      row.remaining === null ? '—' : String(row.remaining),
      row.wallMs === null ? '—' : `${row.wallMs.toFixed(0)}ms`,
      row.source,
      row.note ?? '—',
      row.reason ?? '—',
    ]
  })
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

function summary(rows: ResolvedMechanicalCheck[]): string {
  const enforced = rows.filter((row) => row.enforced).length
  const standards = rows.filter(
    (row) => !row.enforced && (row.source === 'default' || row.source === 'stack'),
  ).length
  const uncovered = rows.filter((row) => !row.enforced && row.source === 'uncovered').length
  const optedOut = rows.filter((row) => row.source === 'opted-out').length
  return `summary: ${enforced} enforced, ${standards} standard defaults not adopted, ${uncovered} uncovered, ${optedOut} opt-outs`
}

function printReport(value: EnforcementReport, presentation: EnforcementPresentation): void {
  presentation.log(value.project)
  for (const line of textTable(value.rows)) presentation.log(line)
  presentation.log(summary(value.rows))
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
    const reports = selectedProjects(options, presentation.cwd(), deps).map((project) =>
      report(project, deps),
    )
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
