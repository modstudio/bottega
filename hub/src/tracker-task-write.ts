import { PLATFORM_SLUG } from '../../shared/brand.ts'
import {
  type StatusCategory,
  TASK_STATUSES,
  type TrackerTask,
  trackerStatusCategory,
  updateArrayMcpTaskStatus,
} from '../../shared/trackers.ts'
import { observeTrackerTask } from './ingest/trackers.ts'
import type { HostedEditDelivery } from './offline-task-edits.ts'
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
  /** Receives the hosted drain result; a throw here propagates to the caller. */
  onHostedDelivery?: (delivery: HostedEditDelivery) => void
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

function requireArrayStatusWriter(task: TaskRow, project: RegisteredProject): void {
  if (project.settings.tracker?.protocol === 'array-mcp') return
  throw new Error(
    `task ${task.key}'s tracker protocol ${project.settings.tracker?.protocol ?? '(missing)'} has no status writer`,
  )
}

function validStateRefusal(project: RegisteredProject, status: string): Error {
  const valid = Object.keys(project.settings.tracker?.states ?? {})
  return new Error(
    `status ${status} does not resolve to exactly one state for project ${project.name}; valid states: ${valid.join(', ') || '(none)'}`,
  )
}

function resolveArrayStatus(
  project: RegisteredProject,
  requested: string,
): { status: string; category: StatusCategory } {
  const states = project.settings.tracker?.states ?? {}
  if (requested in states) {
    return {
      status: requested,
      category: trackerStatusCategory(requested, requested, states),
    }
  }
  if (!TASK_STATUSES.includes(requested as (typeof TASK_STATUSES)[number])) {
    throw validStateRefusal(project, requested)
  }
  const matches = Object.entries(states).filter(([, category]) => category === requested)
  if (matches.length !== 1) throw validStateRefusal(project, requested)
  const [status] = matches[0]!
  return { status, category: requested as StatusCategory }
}

function replyStatus(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null
  const status = (result as { status?: unknown }).status
  return typeof status === 'string' && status.trim() ? status : null
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
  const result = await withTrackerConnection(
    project,
    (client) => updateArrayMcpTaskStatus(client, project, task.external_id!, status, confirm),
    dependencies,
  )
  const reportedStatus = replyStatus(result)
  const observedStatus = reportedStatus ?? status
  const observed: TrackerTask = {
    externalId: task.external_id,
    key: task.key,
    project: task.project,
    title: task.title ?? '',
    status: observedStatus,
    category: reportedStatus
      ? trackerStatusCategory(reportedStatus, reportedStatus, project.settings.tracker?.states)
      : category,
    updatedAt: null,
    assignee: task.assignee,
  }
  ;(dependencies.observe ?? observeTrackerTask)(observed)
  if (observedStatus !== status) {
    throw new Error(
      `tracker answered with status ${observedStatus} after ${status} was requested for task ${task.key}`,
    )
  }
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
  requireArrayStatusWriter(current, project)
  const fields = Object.keys(changes)
  if (fields.length !== 1 || changes.status === undefined) {
    const unsupported = fields.filter((field) => field !== 'status').join(', ') || 'other fields'
    throw new Error(
      `task ${current.key}'s external tracker can only set status; set ${unsupported} in a separate call where supported`,
    )
  }
  const resolved = resolveArrayStatus(project, changes.status)
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
  requireArrayStatusWriter(current, project)
  await prepareExternalDoneTransition(current, attribution, options.abandonReason, dependencies)
  const done = resolveArrayStatus(project, 'done')
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
