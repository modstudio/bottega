// concern: run task linking
/** Derives durable run task and project references from facts already recorded on the run. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { bottegaEntryArgv } from '../../../shared/self-spawn.ts'
import { db, writeTransaction } from '../database/db.ts'
import { type Project, projects } from '../project/projects.ts'

export type HubTaskReference = { key: string; record_id: string; project: string }
type TaskLinkSource = 'launch_key' | 'review_ref' | 'branch' | 'turn'
type ProjectLinkSource = 'task-project' | 'cwd' | 'scratchpad-cwd'

export type RunLinkFacts = {
  record_id: string
  job: string
  launch_key: string | null
  review_ref: string | null
  branch: string | null
  cwd: string | null
  launch_cwd: string | null
  probe: number
  parent_run_record_id: string | null
  task_record_id: string | null
  project_record_id: string | null
}

export type DerivedRunLinks = {
  record_id: string
  task_record_id?: string
  project_record_id?: string
  task_source?: TaskLinkSource
  project_source?: ProjectLinkSource
}

export type RunTaskLinkReport = {
  dry_run: boolean
  task_links_by_source: Record<TaskLinkSource, number>
  project_links_by_source: Record<ProjectLinkSource, number>
  without_task_by_job: Record<string, number>
  without_task_or_project_by_job: Record<string, number>
}

export type HubTaskReader = (project: string) => Promise<HubTaskReference[]>

const TASK_TOKEN = /(?<![A-Za-z0-9])([A-Z][A-Z0-9]+-[0-9]+)(?![0-9])/g

function firstKnownTask(
  text: string | null,
  tasks: ReadonlyMap<string, HubTaskReference>,
): HubTaskReference | null {
  if (!text) return null
  for (const match of text.matchAll(TASK_TOKEN)) {
    const task = tasks.get(match[1]!)
    if (task) return task
  }
  return null
}

function pathPrefixLength(path: string, prefix: string, separator: '/' | '-'): number {
  const normalized = prefix.endsWith(separator) ? prefix.slice(0, -1) : prefix
  if (
    path === normalized ||
    (path.startsWith(normalized) && path[normalized.length] === separator)
  ) {
    return normalized.length
  }
  return -1
}

function longestPathProject(path: string | null, registered: readonly Project[]): Project | null {
  if (!path) return null
  let best: Project | null = null
  let bestLength = -1
  for (const project of registered) {
    const length = pathPrefixLength(path, project.path, '/')
    if (length > bestLength) {
      best = project
      bestLength = length
    }
  }
  return best
}

function longestScratchpadProject(
  path: string | null,
  registered: readonly Project[],
): Project | null {
  if (!path) return null
  let best: Project | null = null
  let bestLength = -1
  for (const segment of path.split('/').filter((part) => part.startsWith('-Users-'))) {
    for (const project of registered) {
      const encoded = project.path.replaceAll('/', '-')
      const length = pathPrefixLength(segment, encoded, '-')
      if (length > bestLength) {
        best = project
        bestLength = length
      }
    }
  }
  return best
}

function deriveTaskLink(
  run: RunLinkFacts,
  tasks: ReadonlyMap<string, HubTaskReference>,
  resolvedTasks: ReadonlyMap<string, string | null>,
): Pick<DerivedRunLinks, 'task_record_id' | 'task_source'> {
  if (run.task_record_id !== null) return {}
  const sources = [
    ['launch_key', run.launch_key ? tasks.get(run.launch_key) : undefined],
    ['review_ref', firstKnownTask(run.review_ref, tasks)],
    ['branch', firstKnownTask(run.branch, tasks)],
  ] as const
  for (const [source, found] of sources) {
    if (found) return { task_record_id: found.record_id, task_source: source }
  }
  const inherited = run.parent_run_record_id ? resolvedTasks.get(run.parent_run_record_id) : null
  return inherited ? { task_record_id: inherited, task_source: 'turn' } : {}
}

function deriveProjectLink(
  run: RunLinkFacts,
  taskRecordId: string | undefined,
  tasksById: ReadonlyMap<string, HubTaskReference>,
  registered: readonly Project[],
  registeredByName: ReadonlyMap<string, Project>,
): Pick<DerivedRunLinks, 'project_record_id' | 'project_source'> {
  if (run.project_record_id !== null || run.probe === 1) return {}
  const linkedTask = taskRecordId ? tasksById.get(taskRecordId) : undefined
  const taskProject = linkedTask ? registeredByName.get(linkedTask.project) : undefined
  if (taskProject) {
    return { project_record_id: taskProject.recordId, project_source: 'task-project' }
  }
  const direct =
    longestPathProject(run.cwd, registered) ?? longestPathProject(run.launch_cwd, registered)
  if (direct) return { project_record_id: direct.recordId, project_source: 'cwd' }
  const scratch =
    longestScratchpadProject(run.cwd, registered) ??
    longestScratchpadProject(run.launch_cwd, registered)
  return scratch ? { project_record_id: scratch.recordId, project_source: 'scratchpad-cwd' } : {}
}

/** Roots precede turns so a turn can inherit a root link derived in this pass. */
export function deriveRunLinks(
  runs: readonly RunLinkFacts[],
  tasks: ReadonlyMap<string, HubTaskReference>,
  registered: readonly Project[],
): DerivedRunLinks[] {
  const ordered = [...runs].sort(
    (a, b) => Number(a.parent_run_record_id !== null) - Number(b.parent_run_record_id !== null),
  )
  const resolvedTasks = new Map(runs.map((run) => [run.record_id, run.task_record_id]))
  const registeredByName = new Map(registered.map((project) => [project.name, project]))
  const tasksById = new Map([...tasks.values()].map((task) => [task.record_id, task]))
  return ordered.map((run) => {
    const taskLink = deriveTaskLink(run, tasks, resolvedTasks)
    resolvedTasks.set(run.record_id, taskLink.task_record_id ?? run.task_record_id)
    return {
      record_id: run.record_id,
      ...taskLink,
      ...deriveProjectLink(run, taskLink.task_record_id, tasksById, registered, registeredByName),
    }
  })
}

function taskReadRefusal(project: string, detail: string): Error {
  return new Error(
    `could not read task data for project ${project}: ${detail}; retry: ${PLATFORM_SLUG} task list --project ${project} --json`,
  )
}

export async function readHubTasks(project: string): Promise<HubTaskReference[]> {
  const child = Bun.spawn(
    [...bottegaEntryArgv(PLATFORM_SLUG), 'task', 'list', '--project', project, '--json'],
    { stdout: 'pipe', stderr: 'pipe', env: { ...process.env } },
  )
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(stderr.trim() || `exit status ${code}`)
  const rows: unknown = JSON.parse(stdout)
  if (!Array.isArray(rows)) throw new Error('response was not an array')
  return rows.map((row) => {
    if (
      !row ||
      typeof row !== 'object' ||
      typeof (row as HubTaskReference).key !== 'string' ||
      typeof (row as HubTaskReference).record_id !== 'string' ||
      typeof (row as HubTaskReference).project !== 'string'
    ) {
      throw new Error('response contained an invalid task row')
    }
    return row as HubTaskReference
  })
}

async function hubTaskMap(
  registered: readonly Project[],
  reader: HubTaskReader = readHubTasks,
): Promise<Map<string, HubTaskReference>> {
  const taskMap = new Map<string, HubTaskReference>()
  for (const project of registered) {
    let rows: HubTaskReference[]
    try {
      rows = await reader(project.name)
    } catch (error) {
      throw taskReadRefusal(project.name, error instanceof Error ? error.message : String(error))
    }
    for (const task of rows) taskMap.set(task.key, task)
  }
  return taskMap
}

function emptyReport(dryRun: boolean): RunTaskLinkReport {
  return {
    dry_run: dryRun,
    task_links_by_source: { launch_key: 0, review_ref: 0, branch: 0, turn: 0 },
    project_links_by_source: { 'task-project': 0, cwd: 0, 'scratchpad-cwd': 0 },
    without_task_by_job: {},
    without_task_or_project_by_job: {},
  }
}

function increment(group: Record<string, number>, key: string): void {
  group[key] = (group[key] ?? 0) + 1
}

export async function linkRunTasks(
  options: { dryRun: boolean },
  dependencies: {
    database?: Database
    registeredProjects?: readonly Project[]
    hubReader?: HubTaskReader
  } = {},
): Promise<RunTaskLinkReport> {
  const database = dependencies.database ?? db()
  const registered = dependencies.registeredProjects ?? projects(undefined, database)
  const tasks = await hubTaskMap(registered, dependencies.hubReader)
  const runs = database
    .query<RunLinkFacts, []>(
      `SELECT record_id,job,launch_key,review_ref,branch,cwd,launch_cwd,probe,
              parent_run_record_id,task_record_id,project_record_id
       FROM run ORDER BY number`,
    )
    .all()
  const links = deriveRunLinks(runs, tasks, registered)
  const report = emptyReport(options.dryRun)
  const byId = new Map(runs.map((run) => [run.record_id, run]))
  for (const link of links) {
    const run = byId.get(link.record_id)!
    if (link.task_source) report.task_links_by_source[link.task_source]++
    if (link.project_source) report.project_links_by_source[link.project_source]++
    const taskId = link.task_record_id ?? run.task_record_id
    const projectId = link.project_record_id ?? run.project_record_id
    if (taskId === null) increment(report.without_task_by_job, run.job)
    if (run.probe !== 1 && taskId === null && projectId === null) {
      increment(report.without_task_or_project_by_job, run.job)
    }
  }
  if (!options.dryRun) {
    writeTransaction(() => {
      const update = database.query(
        `UPDATE run SET task_record_id=COALESCE(task_record_id,?),
                        project_record_id=COALESCE(project_record_id,?)
         WHERE record_id=?`,
      )
      for (const link of links) {
        if (!link.task_record_id && !link.project_record_id) continue
        update.run(link.task_record_id ?? null, link.project_record_id ?? null, link.record_id)
      }
    }, database)
  }
  return report
}

function invalidRunTaskReferenceCount(
  database: Database,
  tasks: ReadonlyMap<string, HubTaskReference>,
): number {
  const ids = new Set([...tasks.values()].map((task) => task.record_id))
  const rows = database
    .query<{ task_record_id: string }, []>(
      'SELECT task_record_id FROM run WHERE task_record_id IS NOT NULL',
    )
    .all()
  return rows.filter((row) => !ids.has(row.task_record_id)).length
}

export function formatRunTaskLinkReport(report: RunTaskLinkReport): string[] {
  const format = (rows: Record<string, number>) =>
    Object.entries(rows)
      .filter(([, count]) => count > 0)
      .map(([name, count]) => `${name} ${count}`)
      .join(', ') || 'none'
  return [
    `task links: ${format(report.task_links_by_source)}`,
    `project links: ${format(report.project_links_by_source)}`,
    `without task by job: ${format(report.without_task_by_job)}`,
    `without task or project by job: ${format(report.without_task_or_project_by_job)}`,
  ]
}

export async function sweepRunTaskLinks(
  dryRun: boolean,
  hubReader: HubTaskReader,
): Promise<{ kind: 'log' | 'error'; line: string }> {
  try {
    const linked = await linkRunTasks({ dryRun }, { hubReader })
    const taskLinks = Object.values(linked.task_links_by_source).reduce(
      (sum, count) => sum + count,
      0,
    )
    const projectLinks = Object.values(linked.project_links_by_source).reduce(
      (sum, count) => sum + count,
      0,
    )
    return { kind: 'log', line: `run links: task ${taskLinks}, project ${projectLinks}` }
  } catch (error) {
    return {
      kind: 'error',
      line: `run links unavailable: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

export async function runTaskReferenceDoctorLine(): Promise<string> {
  try {
    const tasks = await hubTaskMap(projects())
    return `run task refs  ${invalidRunTaskReferenceCount(db(), tasks)} name no task in hub`
  } catch (error) {
    return `run task refs  unavailable — ${error instanceof Error ? error.message : String(error)}`
  }
}
