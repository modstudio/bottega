import { PLATFORM_SLUG } from '../../shared/brand.ts'
import {
  type StatusCategory,
  type TrackerTask,
  updateArrayMcpTaskStatus,
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
  type TaskComment,
  type TaskRow,
} from './task.ts'
import type { Attribution } from './task-attribution.ts'
import type { TaskScope } from './task-identity.ts'
import { type TrackerConnectionDependencies, withTrackerConnection } from './tracker-connection.ts'

type TrackerWriteDependencies = TrackerConnectionDependencies & {
  registeredProjects?: () => RegisteredProject[]
  observe?: typeof observeTrackerTask
  classify?: typeof classifyTaskBranches
  localSet?: typeof setTask
  localClose?: typeof closeTask
  localComment?: typeof commentTask
}
type TrackerWriteOptions = { force?: boolean; abandonReason?: string; confirm: string }
export type TaskChanges = {
  title?: string
  status?: string
  parent?: string | null
  body?: string
  assignee?: string | null
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

function arrayStatusCategory(project: RegisteredProject, status: string): StatusCategory {
  if (project.settings.tracker?.protocol !== 'array-mcp') {
    throw new Error(
      `tracker protocol ${project.settings.tracker?.protocol ?? '(missing)'} has no status writer`,
    )
  }
  const category = project.settings.tracker.states?.[status]
  if (!category)
    throw new Error(`status ${status} is not in project ${project.name}'s tracker vocabulary`)
  return category === 'backlog' ? 'open' : category
}

async function writeExternalStatus(
  task: TaskRow,
  project: RegisteredProject,
  status: string,
  category: StatusCategory,
  confirm: string,
  dependencies: TrackerWriteDependencies,
): Promise<TaskRow> {
  if (!task.external_id) throw new Error(`task ${task.key} has no external tracker id`)
  await withTrackerConnection(
    project,
    (client) => updateArrayMcpTaskStatus(client, project, task.external_id!, status, confirm),
    dependencies,
  )
  const observed: TrackerTask = {
    externalId: task.external_id,
    key: task.key,
    project: task.project,
    title: task.title ?? '',
    status,
    category,
    updatedAt: null,
    assignee: task.assignee,
  }
  ;(dependencies.observe ?? observeTrackerTask)(observed)
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
  if (project.settings.tracker?.protocol !== 'array-mcp') {
    throw new Error(
      `task ${current.key}'s tracker protocol ${project.settings.tracker?.protocol ?? '(missing)'} has no status writer`,
    )
  }
  const fields = Object.keys(changes)
  if (fields.length !== 1 || changes.status === undefined) {
    const unsupported = fields.filter((field) => field !== 'status').join(', ') || 'other fields'
    throw new Error(
      `task ${current.key}'s external tracker can only set status; set ${unsupported} in a separate call where supported`,
    )
  }
  const category = arrayStatusCategory(project, changes.status)
  if (category === 'done') {
    await prepareExternalDoneTransition(current, attribution, options.abandonReason, dependencies)
  }
  return writeExternalStatus(
    current,
    project,
    changes.status,
    category,
    options.confirm,
    dependencies,
  )
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
  if (project.settings.tracker?.protocol !== 'array-mcp') {
    throw new Error(
      `task ${current.key}'s tracker protocol ${project.settings.tracker?.protocol ?? '(missing)'} has no status writer`,
    )
  }
  await prepareExternalDoneTransition(current, attribution, options.abandonReason, dependencies)
  const done = Object.entries(project.settings.tracker.states ?? {}).find(
    ([, category]) => category === 'done',
  )?.[0]
  if (!done) throw new Error(`project ${project.name} tracker has no done state configured`)
  const category = arrayStatusCategory(project, done)
  return writeExternalStatus(current, project, done, category, options.confirm, dependencies)
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
