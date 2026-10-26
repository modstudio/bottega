// concern: run task linking
/** Derives durable run task and project references from facts already recorded on the run. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { bottegaEntryArgv } from '../../../shared/self-spawn.ts'
import { db, writableDb, writeTransaction } from '../database/db.ts'
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

export type NewRunLinkFacts = {
  key: string | null
  cwd: string | null
  launchCwd: string | null
  probe: boolean
  inheritedTaskRecordId?: string | null
  inheritedProjectRecordId?: string | null
  projectRecordId: string | null
}

export type RunTaskLinkReport = {
  dry_run: boolean
  task_links_by_source: Record<TaskLinkSource, number>
  project_links_by_source: Record<ProjectLinkSource, number>
  without_task_by_job: Record<string, number>
  keys_without_task: Record<string, number>
  without_task_or_project_by_job: Record<string, number>
  local_task_links: Record<LocalTaskLinkTable, LocalTaskLinkResult>
}

export type HubTaskReader = (project: string) => Promise<HubTaskReference[]>

type LocalTaskLinkTable = 'workflow_cursor' | 'question' | 'port_ref' | 'presence'
type LocalTaskLinkResult = { linked: number; unmatched_keys: Record<string, number> }
type PendingLocalTaskLink = {
  table: LocalTaskLinkTable
  id: string
  taskId: string
}

export async function resolveHubTaskReference(
  project: string,
  key: string,
  reader: HubTaskReader = readHubTasks,
): Promise<HubTaskReference | null> {
  let rows: HubTaskReference[]
  try {
    rows = await reader(project)
  } catch (error) {
    throw taskReadRefusal(project, error instanceof Error ? error.message : String(error))
  }
  return rows.find((task) => task.key === key) ?? null
}

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
  if (run.task_record_id !== null || run.probe === 1) return {}
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

/** Applies the recorded-row policy to the facts known before a new run is inserted. */
export function deriveNewRunLinks(
  input: NewRunLinkFacts,
  tasks: ReadonlyMap<string, HubTaskReference>,
  registered: readonly Project[],
): { taskRecordId: string | null; projectRecordId: string | null } {
  const inheritedProjectRecordId = input.inheritedProjectRecordId ?? null
  const facts: RunLinkFacts = {
    record_id: 'new-run',
    job: 'new-run',
    launch_key: input.key,
    review_ref: null,
    branch: null,
    cwd: input.cwd,
    launch_cwd: input.launchCwd,
    probe: input.probe ? 1 : 0,
    parent_run_record_id: null,
    task_record_id: input.inheritedTaskRecordId ?? null,
    project_record_id: inheritedProjectRecordId ?? input.projectRecordId,
  }
  const derived = deriveRunLinks([facts], tasks, registered)[0]!
  return {
    taskRecordId: derived.task_record_id ?? facts.task_record_id,
    projectRecordId: derived.project_record_id ?? facts.project_record_id,
  }
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
    keys_without_task: {},
    without_task_or_project_by_job: {},
    local_task_links: {
      workflow_cursor: { linked: 0, unmatched_keys: {} },
      question: { linked: 0, unmatched_keys: {} },
      port_ref: { linked: 0, unmatched_keys: {} },
      presence: { linked: 0, unmatched_keys: {} },
    },
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
  const database = dependencies.database ?? (options.dryRun ? db() : writableDb())
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
    if (taskId === null && run.launch_key && !tasks.has(run.launch_key)) {
      increment(report.keys_without_task, run.launch_key)
    }
    if (run.probe !== 1 && taskId === null && projectId === null) {
      increment(report.without_task_or_project_by_job, run.job)
    }
  }
  const localLinks: LocalTaskLinkTable[] = ['workflow_cursor', 'question', 'port_ref', 'presence']
  const pendingUpdates: PendingLocalTaskLink[] = []
  for (const table of localLinks) {
    const rows = localTaskLinkRows(database, table)
    for (const row of rows) {
      const task = tasks.get(row.task_key)
      if (task) {
        report.local_task_links[table].linked++
        pendingUpdates.push({
          table,
          id: row.id,
          taskId: task.record_id,
        })
      } else {
        increment(report.local_task_links[table].unmatched_keys, row.task_key)
      }
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
      for (const update of pendingUpdates) {
        writeLocalTaskLink(database, update)
      }
    }, database)
  }
  return report
}

function localTaskLinkRows(
  database: Database,
  table: LocalTaskLinkTable,
): Array<{ id: string; task_key: string }> {
  if (table === 'workflow_cursor')
    return database
      .query<{ id: string; task_key: string }, []>(
        "SELECT record_id id,workflow_key task_key FROM workflow_cursor WHERE task_record_id IS NULL AND workflow_key<>''",
      )
      .all()
  if (table === 'question')
    return database
      .query<{ id: string; task_key: string }, []>(
        'SELECT record_id id,workflow_key task_key FROM question WHERE workflow_task_record_id IS NULL AND workflow_key IS NOT NULL',
      )
      .all()
  if (table === 'port_ref')
    return database
      .query<{ id: string; task_key: string }, []>(
        'SELECT record_id id,task_key FROM port_ref WHERE task_record_id IS NULL',
      )
      .all()
  return database
    .query<{ id: string; task_key: string }, []>(
      'SELECT session_id id,current_task_key task_key FROM presence WHERE current_task_record_id IS NULL AND current_task_key IS NOT NULL',
    )
    .all()
}

function writeLocalTaskLink(database: Database, update: PendingLocalTaskLink): void {
  if (update.table === 'workflow_cursor')
    database
      .query(
        'UPDATE workflow_cursor SET task_record_id=? WHERE record_id=? AND task_record_id IS NULL',
      )
      .run(update.taskId, update.id)
  else if (update.table === 'question')
    database
      .query(
        'UPDATE question SET workflow_task_record_id=? WHERE record_id=? AND workflow_task_record_id IS NULL',
      )
      .run(update.taskId, update.id)
  else if (update.table === 'port_ref')
    database
      .query('UPDATE port_ref SET task_record_id=? WHERE record_id=? AND task_record_id IS NULL')
      .run(update.taskId, update.id)
  else
    database
      .query(
        'UPDATE presence SET current_task_record_id=? WHERE session_id=? AND current_task_record_id IS NULL',
      )
      .run(update.taskId, update.id)
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
  const local = Object.entries(report.local_task_links).flatMap(([table, result]) => [
    `${table} task links: ${result.linked}`,
    `${table} keys naming no task: ${format(result.unmatched_keys)}`,
  ])
  return [
    `task links: ${format(report.task_links_by_source)}`,
    `project links: ${format(report.project_links_by_source)}`,
    `without task by job: ${format(report.without_task_by_job)}`,
    `keys naming no task: ${format(report.keys_without_task)}`,
    `without task or project by job: ${format(report.without_task_or_project_by_job)}`,
    ...local,
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
    const localLinks = Object.values(linked.local_task_links).reduce(
      (sum, result) => sum + result.linked,
      0,
    )
    const localReports = Object.entries(linked.local_task_links).map(([table, result]) => {
      const unmatched = Object.entries(result.unmatched_keys)
        .map(([key, count]) => `${key} ${count}`)
        .join(', ')
      return `${table} linked ${result.linked}, unmatched ${unmatched || 'none'}`
    })
    return {
      kind: 'log',
      line: `run links: task ${taskLinks}, project ${projectLinks}, related rows ${localLinks}; ${localReports.join('; ')}`,
    }
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
    const ids = new Set([...tasks.values()].map((task) => task.record_id))
    const database = db()
    const related = [
      [
        'workflow_cursor',
        database
          .query<{ task_record_id: string }, []>(
            'SELECT task_record_id FROM workflow_cursor WHERE task_record_id IS NOT NULL',
          )
          .all(),
      ],
      [
        'question',
        database
          .query<{ task_record_id: string }, []>(
            'SELECT workflow_task_record_id task_record_id FROM question WHERE workflow_task_record_id IS NOT NULL',
          )
          .all(),
      ],
      [
        'port_ref',
        database
          .query<{ task_record_id: string }, []>(
            'SELECT task_record_id FROM port_ref WHERE task_record_id IS NOT NULL',
          )
          .all(),
      ],
      [
        'presence',
        database
          .query<{ task_record_id: string }, []>(
            'SELECT current_task_record_id task_record_id FROM presence WHERE current_task_record_id IS NOT NULL',
          )
          .all(),
      ],
    ].map(
      ([table, rows]) =>
        `${table} ${(rows as { task_record_id: string }[]).filter((row) => !ids.has(row.task_record_id)).length}`,
    )
    return `run task refs  ${invalidRunTaskReferenceCount(db(), tasks)} run; ${related.join(', ')} name no task in hub`
  } catch (error) {
    return `run task refs  unavailable — ${error instanceof Error ? error.message : String(error)}`
  }
}
