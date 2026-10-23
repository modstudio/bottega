import { PLATFORM_SLUG } from '../../shared/brand.ts'
import {
  type StatusCategory,
  type ToolCaller,
  type TrackerTask,
  updateArrayMcpTaskStatus,
} from '../../shared/trackers.ts'
import { observeTrackerTask } from './ingest/trackers.ts'
import { credentials, failureDetail, Mcp } from './mcp.ts'
import { classifyTaskBranches } from './orch.ts'
import { projects, type RegisteredProject } from './projects.ts'
import {
  closeTask,
  commentTask,
  setTask,
  showTask,
  type TaskComment,
  type TaskRow,
} from './task.ts'
import type { Attribution } from './task-attribution.ts'
import { decideTaskClose, landingCheck } from './task-close-decision.ts'
import type { TaskScope } from './task-identity.ts'

type TrackerConnection = ToolCaller & { close(): Promise<void> }
type TrackerWriteDependencies = {
  registeredProjects?: () => RegisteredProject[]
  readCredentials?: typeof credentials
  connect?: (url: string, token: string) => Promise<TrackerConnection>
  observe?: typeof observeTrackerTask
  classify?: typeof classifyTaskBranches
  localSet?: typeof setTask
  localClose?: typeof closeTask
  localComment?: typeof commentTask
}
type StatusWriteOptions = { force?: boolean; abandonReason?: string }

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
  const category = project.settings.tracker?.states?.[status]
  if (!category) {
    throw new Error(`status ${status} is not in project ${project.name}'s tracker vocabulary`)
  }
  return category === 'backlog' ? 'open' : category
}

async function callArrayStatusAdapter(
  task: TaskRow,
  project: RegisteredProject,
  status: string,
  dependencies: TrackerWriteDependencies,
): Promise<void> {
  if (!task.external_id) throw new Error(`task ${task.key} has no external tracker id`)
  const env = project.settings.tracker?.envPrefix ?? project.settings.envPrefix
  if (!env) throw new Error(`project ${project.name} tracker is missing envPrefix`)
  const auth = await (dependencies.readCredentials ?? credentials)(env)
  if (!auth) throw new Error(`credentials for ${project.name} tracker do not resolve`)
  let client: TrackerConnection | null = null
  let operationFailure: unknown
  try {
    client = dependencies.connect
      ? await dependencies.connect(auth.url, auth.token)
      : new Mcp(auth.url, auth.token)
    if (!dependencies.connect) await (client as Mcp).initialize()
    await updateArrayMcpTaskStatus(client, project, task.external_id, status)
  } catch (error) {
    operationFailure = error
  }
  let closeFailure: unknown
  if (client) {
    try {
      await client.close()
    } catch (error) {
      closeFailure = error
    }
  }
  const failure = operationFailure ?? closeFailure
  if (failure !== undefined) throw new Error(failureDetail(failure, auth.token))
}

async function writeExternalStatus(
  task: TaskRow,
  status: string,
  dependencies: TrackerWriteDependencies,
): Promise<TaskRow> {
  const project = registeredProjectFor(task, dependencies)
  if (project.settings.tracker?.protocol !== 'array-mcp') {
    throw new Error(`task ${task.key} is not local`)
  }
  const category = arrayStatusCategory(project, status)
  await callArrayStatusAdapter(task, project, status, dependencies)
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

async function ensureExternalDoneTransition(
  task: TaskRow,
  abandonReason: string | undefined,
  dependencies: TrackerWriteDependencies,
): Promise<void> {
  if (abandonReason) {
    throw new Error(
      `cannot abandon unlanded work for task ${task.key}: task is not local and cannot take a comment`,
    )
  }
  let classification: ReturnType<typeof landingCheck>
  try {
    classification = landingCheck(
      await (dependencies.classify ?? classifyTaskBranches)(task.project, task.key),
    )
  } catch (error) {
    classification = {
      available: false,
      reason: error instanceof Error ? error.message : String(error),
    }
  }
  const decision = decideTaskClose(classification)
  if (decision.action === 'refuse') throw new Error(decision.reason)
}

export async function setTaskStatusThroughTracker(
  key: string,
  scope: TaskScope,
  status: string,
  attribution: Attribution,
  options: StatusWriteOptions = {},
  dependencies: TrackerWriteDependencies = {},
): Promise<TaskRow> {
  const current = showTask(key, scope).task
  if (current.source === 'local') {
    return (dependencies.localSet ?? setTask)(key, scope, { status }, attribution, options)
  }
  const project = registeredProjectFor(current, dependencies)
  if (arrayStatusCategory(project, status) === 'done') {
    await ensureExternalDoneTransition(current, options.abandonReason, dependencies)
  }
  return writeExternalStatus(current, status, dependencies)
}

export async function closeTaskThroughTracker(
  key: string,
  scope: TaskScope,
  attribution: Attribution,
  options: { abandonReason?: string },
  dependencies: TrackerWriteDependencies = {},
): Promise<TaskRow> {
  const current = showTask(key, scope).task
  if (current.source === 'local') {
    return (dependencies.localClose ?? closeTask)(key, scope, attribution, options)
  }
  await ensureExternalDoneTransition(current, options.abandonReason, dependencies)
  const project = registeredProjectFor(current, dependencies)
  const done = Object.entries(project.settings.tracker?.states ?? {}).find(
    ([, category]) => category === 'done',
  )?.[0]
  if (!done) throw new Error(`project ${project.name} tracker has no done state configured`)
  return writeExternalStatus(current, done, dependencies)
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
