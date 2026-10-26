// concern: run task linking
/** Derives durable run task and project references from facts already recorded on the run. */

import type { Database } from 'bun:sqlite'
import { db, writableDb, writeTransaction } from '../database/db.ts'
import { type Project, projects } from '../project/projects.ts'
import { linkWorkflowTaskLabel } from '../workflow/workflow-task-linking.ts'
import {
  type HubTaskReader,
  type HubTaskReference,
  readHubTasks,
  taskReadRefusal,
} from '../workflow/workflow-task-reference.ts'
import { linkWorkflowQuestionsTaskReference } from './question-mutation.ts'

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

type LocalTaskLinkTable = 'workflow_cursor' | 'question' | 'port_ref' | 'presence'
type LocalTaskLinkResult = { linked: number; unmatched_keys: Record<string, number> }
type PendingLocalTaskLink = {
  table: LocalTaskLinkTable
  id: string
  taskId: string
  project: string
  taskKey: string
}

type LocalTaskLinkRow = { id: string; task_key: string; project: string }
type LocalTaskLinkConfig = {
  pendingSql: string
  linkedSql: string
  write(database: Database, update: PendingLocalTaskLink): void
}

const LOCAL_TASK_LINKS = {
  workflow_cursor: {
    pendingSql: `SELECT c.record_id id,c.workflow_key task_key,p.name project
      FROM workflow_cursor c JOIN project p ON p.record_id=c.project_record_id
      WHERE c.task_record_id IS NULL AND c.workflow_key<>''`,
    linkedSql: `SELECT c.task_record_id,p.name project FROM workflow_cursor c
      JOIN project p ON p.record_id=c.project_record_id WHERE c.task_record_id IS NOT NULL`,
    write: (database, update) => {
      linkWorkflowTaskLabel(database, {
        project: update.project,
        workflowKey: update.taskKey,
        taskRecordId: update.taskId,
      })
    },
  },
  question: {
    pendingSql: `SELECT q.record_id id,q.workflow_key task_key,p.name project
      FROM question q JOIN workflow_cursor c ON c.record_id=q.workflow_cursor_record_id
      JOIN project p ON p.record_id=c.project_record_id
      WHERE q.workflow_task_record_id IS NULL AND q.workflow_key IS NOT NULL`,
    linkedSql: `SELECT q.workflow_task_record_id task_record_id,p.name project
      FROM question q JOIN workflow_cursor c ON c.record_id=q.workflow_cursor_record_id
      JOIN project p ON p.record_id=c.project_record_id
      WHERE q.workflow_task_record_id IS NOT NULL`,
    write: (database, update) => {
      linkWorkflowQuestionsTaskReference(
        {
          project: update.project,
          workflowKey: update.taskKey,
          taskRecordId: update.taskId,
        },
        database,
      )
    },
  },
  port_ref: {
    pendingSql: `SELECT r.record_id id,r.task_key,p.name project FROM port_ref r
      JOIN project p ON p.record_id=r.target_project_record_id WHERE r.task_record_id IS NULL`,
    linkedSql: `SELECT r.task_record_id,p.name project FROM port_ref r
      JOIN project p ON p.record_id=r.target_project_record_id WHERE r.task_record_id IS NOT NULL`,
    write: (database, update) => {
      database
        .query('UPDATE port_ref SET task_record_id=? WHERE record_id=? AND task_record_id IS NULL')
        .run(update.taskId, update.id)
    },
  },
  presence: {
    pendingSql: `SELECT s.session_id id,s.current_task_key task_key,p.name project FROM presence s
      JOIN project p ON p.record_id=s.project_record_id
      WHERE s.current_task_record_id IS NULL AND s.current_task_key IS NOT NULL`,
    linkedSql: `SELECT s.current_task_record_id task_record_id,p.name project FROM presence s
      JOIN project p ON p.record_id=s.project_record_id WHERE s.current_task_record_id IS NOT NULL`,
    write: (database, update) => {
      database
        .query(
          'UPDATE presence SET current_task_record_id=? WHERE session_id=? AND current_task_record_id IS NULL',
        )
        .run(update.taskId, update.id)
    },
  },
} satisfies Record<LocalTaskLinkTable, LocalTaskLinkConfig>

const localTaskLinkTables = () => Object.keys(LOCAL_TASK_LINKS) as LocalTaskLinkTable[]

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

async function hubTaskMap(
  registered: readonly Project[],
  reader: HubTaskReader = readHubTasks,
): Promise<{
  byKey: Map<string, HubTaskReference>
  byProjectKey: Map<string, HubTaskReference>
  byProjectId: Map<string, HubTaskReference>
  ambiguousKeys: Set<string>
}> {
  const byKey = new Map<string, HubTaskReference>()
  const byProjectKey = new Map<string, HubTaskReference>()
  const byProjectId = new Map<string, HubTaskReference>()
  const projectsByKey = new Map<string, Set<string>>()
  for (const project of registered) {
    let rows: HubTaskReference[]
    try {
      rows = await reader(project.name)
    } catch (error) {
      throw taskReadRefusal(
        project.name,
        '',
        error instanceof Error ? error.message : String(error),
      )
    }
    for (const task of rows) {
      byKey.set(task.key, task)
      byProjectKey.set(`${task.project}\0${task.key}`, task)
      byProjectId.set(`${task.project}\0${task.record_id}`, task)
      const owners = projectsByKey.get(task.key) ?? new Set<string>()
      owners.add(task.project)
      projectsByKey.set(task.key, owners)
    }
  }
  return {
    byKey,
    byProjectKey,
    byProjectId,
    ambiguousKeys: new Set(
      [...projectsByKey].filter(([, owners]) => owners.size > 1).map(([key]) => key),
    ),
  }
}

function emptyReport(dryRun: boolean): RunTaskLinkReport {
  return {
    dry_run: dryRun,
    task_links_by_source: { launch_key: 0, review_ref: 0, branch: 0, turn: 0 },
    project_links_by_source: { 'task-project': 0, cwd: 0, 'scratchpad-cwd': 0 },
    without_task_by_job: {},
    keys_without_task: {},
    without_task_or_project_by_job: {},
    local_task_links: Object.fromEntries(
      localTaskLinkTables().map((table) => [table, { linked: 0, unmatched_keys: {} }]),
    ) as Record<LocalTaskLinkTable, LocalTaskLinkResult>,
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
  const taskIndex = await hubTaskMap(registered, dependencies.hubReader)
  const tasks = taskIndex.byKey
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
  const pendingUpdates = deriveLocalTaskLinks(database, taskIndex, report)
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

function deriveLocalTaskLinks(
  database: Database,
  tasks: Awaited<ReturnType<typeof hubTaskMap>>,
  report: RunTaskLinkReport,
): PendingLocalTaskLink[] {
  const pending: PendingLocalTaskLink[] = []
  for (const table of localTaskLinkTables()) {
    for (const row of localTaskLinkRows(database, table)) {
      const task = tasks.ambiguousKeys.has(row.task_key)
        ? undefined
        : tasks.byProjectKey.get(`${row.project}\0${row.task_key}`)
      if (!task) {
        increment(report.local_task_links[table].unmatched_keys, row.task_key)
        continue
      }
      report.local_task_links[table].linked++
      pending.push({
        table,
        id: row.id,
        taskId: task.record_id,
        project: row.project,
        taskKey: row.task_key,
      })
    }
  }
  return pending
}

function localTaskLinkRows(database: Database, table: LocalTaskLinkTable): LocalTaskLinkRow[] {
  return database.query<LocalTaskLinkRow, []>(LOCAL_TASK_LINKS[table].pendingSql).all()
}

function writeLocalTaskLink(database: Database, update: PendingLocalTaskLink): void {
  LOCAL_TASK_LINKS[update.table].write(database, update)
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
    const database = db()
    const related = localTaskLinkTables().map((table) => {
      const rows = database
        .query<{ task_record_id: string; project: string }, []>(LOCAL_TASK_LINKS[table].linkedSql)
        .all()
      const invalid = rows.filter(
        (row) =>
          tasks.byProjectId.get(`${row.project}\0${row.task_record_id}`)?.record_id !==
          row.task_record_id,
      ).length
      return `${table} ${invalid}`
    })
    return `run task refs  ${invalidRunTaskReferenceCount(db(), tasks.byKey)} run; ${related.join(', ')} name no task in hub`
  } catch (error) {
    return `run task refs  unavailable — ${error instanceof Error ? error.message : String(error)}`
  }
}
