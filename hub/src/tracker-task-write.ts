import { PLATFORM_SLUG } from '../../shared/brand.ts'
import {
  resolveTrackerWriteState,
  type StatusCategory,
  TASK_STATUSES,
  TRACKER_PROTOCOLS,
  type TrackerTask,
  trackerSourceFor,
} from '../../shared/trackers.ts'
import { observeTrackerTask } from './ingest/trackers.ts'
import { classifyTaskBranches } from './orch.ts'
import { projects, type RegisteredProject } from './projects.ts'
import {
  closeTask,
  commentTask,
  prepareDoneTransition,
  setTask,
  showTask,
  type TaskChanges,
  type TaskComment,
  type TaskRow,
} from './task.ts'
import type { Attribution } from './task-attribution.ts'
import type { TaskScope } from './task-identity.ts'
import type { HostedTaskWriteOptions } from './task-write-destination.ts'
import { type TrackerConnectionDependencies, withTrackerConnection } from './tracker-connection.ts'

type TrackerWriteDependencies = TrackerConnectionDependencies & {
  registeredProjects?: () => RegisteredProject[]
  observe?: typeof observeTrackerTask
  classify?: typeof classifyTaskBranches
  localSet?: typeof setTask
  localClose?: typeof closeTask
  localComment?: typeof commentTask
}
type TrackerWriteOptions = {
  force?: boolean
  abandonReason?: string
  confirm: string
  /** The destination the write belongs to, so a hosted local row lands where its caller read it. */
  hosted?: HostedTaskWriteOptions
}

function registeredProjectFor(
  task: TaskRow,
  dependencies: TrackerWriteDependencies,
): RegisteredProject {
  const project = (dependencies.registeredProjects ?? projects)().find(
    (candidate) => candidate.name === task.project,
  )
  if (!project) throw new Error(`unknown project '${task.project}'`)
  return project
}

function validStateRefusal(project: RegisteredProject, status: string): Error {
  const valid = Object.keys(project.settings.tracker?.states ?? {})
  return new Error(
    `status ${status} does not resolve to exactly one state for project ${project.name}; valid states: ${valid.join(', ') || '(none)'}`,
  )
}

function resolveExternalStatus(
  project: RegisteredProject,
  requested: string,
): { status: string; category: StatusCategory } {
  const states = project.settings.tracker?.states ?? {}
  const mapped = states[requested]
  const category = TASK_STATUSES.includes(requested as (typeof TASK_STATUSES)[number])
    ? (requested as StatusCategory)
    : mapped === 'backlog'
      ? 'open'
      : mapped
  if (!category || !TASK_STATUSES.includes(category as (typeof TASK_STATUSES)[number])) {
    throw validStateRefusal(project, requested)
  }
  const protocol = project.settings.tracker?.protocol
  if (!protocol || !TRACKER_PROTOCOLS.includes(protocol as (typeof TRACKER_PROTOCOLS)[number])) {
    throw validStateRefusal(project, requested)
  }
  const status = resolveTrackerWriteState(
    project.name,
    project.settings.tracker ?? {},
    protocol as (typeof TRACKER_PROTOCOLS)[number],
    category as StatusCategory,
  )
  if (!status) throw validStateRefusal(project, requested)
  return { status, category: category as StatusCategory }
}

async function writeExternalStatus(
  task: TaskRow,
  project: RegisteredProject,
  status: string,
  category: StatusCategory,
  confirm: string,
  dependencies: TrackerWriteDependencies,
): Promise<TaskRow> {
  const source = trackerSourceFor(project)
  if (!source?.writeStatus) {
    throw new Error(
      `task ${task.key}'s tracker protocol ${project.settings.tracker?.protocol ?? '(missing)'} has no status writer`,
    )
  }
  const result = await withTrackerConnection(
    project,
    (client) =>
      source.writeStatus!(
        client,
        { externalId: task.external_id, key: task.key },
        status,
        category,
        confirm,
      ),
    dependencies,
  )
  const observed: TrackerTask = {
    externalId: task.external_id,
    key: task.key,
    project: task.project,
    title: task.title ?? '',
    status: result.status,
    category: result.category,
    updatedAt: null,
    assignee: task.assignee,
  }
  ;(dependencies.observe ?? observeTrackerTask)(observed)
  if (result.refusal) throw new Error(result.refusal)
  return showTask(task.key, { recordId: task.record_id }).task
}

async function prepareExternalDoneTransition(
  task: TaskRow,
  attribution: Attribution,
  abandonReason: string | undefined,
  dependencies: TrackerWriteDependencies,
): Promise<void> {
  await prepareDoneTransition(task, attribution, {
    abandonReason,
    classify: dependencies.classify ?? classifyTaskBranches,
    externalAbandonRefusal: `task ${task.key}'s tracker has no comment writer, so --abandon cannot record its reason; land each branch or delete it, then retry`,
  })
}

export async function setTaskThroughTracker(
  key: string,
  scope: TaskScope,
  changes: TaskChanges,
  attribution: Attribution,
  options: TrackerWriteOptions,
  dependencies: TrackerWriteDependencies = {},
): Promise<TaskRow> {
  const current = showTask(key, scope).task
  if (current.source === 'local') {
    return (dependencies.localSet ?? setTask)(key, scope, changes, attribution, options)
  }
  const project = registeredProjectFor(current, dependencies)
  const fields = Object.keys(changes)
  if (fields.length !== 1 || changes.status === undefined) {
    const unsupported = fields.filter((field) => field !== 'status').join(', ') || 'other fields'
    throw new Error(
      `task ${current.key}'s external tracker can only set status; set ${unsupported} in a separate call where supported`,
    )
  }
  const resolved = resolveExternalStatus(project, changes.status)
  const { status, category } = resolved
  if (category === 'done') {
    await prepareExternalDoneTransition(current, attribution, options.abandonReason, dependencies)
  }
  return writeExternalStatus(current, project, status, category, options.confirm, dependencies)
}

export async function closeTaskThroughTracker(
  key: string,
  scope: TaskScope,
  attribution: Attribution,
  options: { abandonReason?: string; confirm: string },
  dependencies: TrackerWriteDependencies = {},
): Promise<TaskRow> {
  const current = showTask(key, scope).task
  if (current.source === 'local') {
    return (dependencies.localClose ?? closeTask)(key, scope, attribution, options)
  }
  const project = registeredProjectFor(current, dependencies)
  await prepareExternalDoneTransition(current, attribution, options.abandonReason, dependencies)
  const done = resolveExternalStatus(project, 'done')
  return writeExternalStatus(
    current,
    project,
    done.status,
    done.category,
    options.confirm,
    dependencies,
  )
}

export async function commentTaskThroughTracker(
  key: string,
  scope: TaskScope,
  body: string,
  attribution: Attribution,
  dependencies: TrackerWriteDependencies = {},
): Promise<TaskComment> {
  const current = showTask(key, scope).task
  if (current.source === 'local') {
    return (dependencies.localComment ?? commentTask)(key, scope, body, attribution)
  }
  const project = registeredProjectFor(current, dependencies)
  if (project.settings.tracker?.protocol === 'array-mcp') {
    throw new Error(
      `task ${current.key}'s array-mcp tracker exposes no comment action; record the text on the workflow cursor with: ${PLATFORM_SLUG} workflow attach --cursor <cursor> --file <path>`,
    )
  }
  throw new Error(`task ${current.key} is not local`)
}
