import { type ToolCaller, type TrackerSource, trackerSourceFor } from '../../shared/trackers.ts'
import { upsertTrackerTask } from './ingest/trackers.ts'
import { credentials, Mcp } from './mcp.ts'
import { projects, type RegisteredProject } from './projects.ts'
import { DuplicateTaskError, duplicateCandidates, listTasks } from './task.ts'
import {
  createAdvertisedTrackerTaskKey,
  taskCreationDestination,
  trackerTaskInput,
} from './tracker-new.ts'

type TrackerOwnedTaskInput = {
  project: string
  title: string
  body?: string
  status?: string
  parent?: string
}

type FreshTaskDependencies = {
  registeredProjects?: () => RegisteredProject[]
  sourceFor?: (project: RegisteredProject) => TrackerSource | null
  readCredentials?: typeof credentials
  connect?: (url: string, token: string) => Promise<ToolCaller & { close(): Promise<void> }>
  upsert?: typeof upsertTrackerTask
}

export type FreshTaskResult = {
  trackerRead: boolean
  commentsVerifiable: boolean
}

function projectForTask(
  key: string,
  projectName: string | undefined,
  registered: RegisteredProject[],
): RegisteredProject {
  if (projectName) {
    const project = registered.find((candidate) => candidate.name === projectName)
    if (!project) throw new Error(`unknown project '${projectName}'`)
    return project
  }
  const prefix = key.toUpperCase().split('-', 1)[0]
  const matches = registered.filter((project) => project.settings.keyPrefixes?.includes(prefix!))
  if (matches.length === 1) return matches[0]!
  const stored = listTasks().filter((task) => task.key === key.toUpperCase())
  if (stored.length === 1) {
    const project = registered.find((candidate) => candidate.name === stored[0]!.project)
    if (project) return project
  }
  throw new Error(
    `cannot determine the project for task ${key}; pass --project <project> or register its key prefix`,
  )
}

/** Refresh one externally tracked task without taking the whole-collection lease. */
export async function refreshTrackerTask(
  key: string,
  projectName?: string,
  dependencies: FreshTaskDependencies = {},
): Promise<FreshTaskResult> {
  const project = projectForTask(key, projectName, (dependencies.registeredProjects ?? projects)())
  const source = (dependencies.sourceFor ?? trackerSourceFor)(project)
  if (!source) return { trackerRead: false, commentsVerifiable: true }
  if (!source.lookup)
    throw new Error(`project ${project.name} tracker has no single-task lookup for ${key}`)

  const resolved = await (dependencies.readCredentials ?? credentials)(source.env)
  if (!resolved) throw new Error(`credentials for ${project.name} tracker do not resolve`)
  const client = dependencies.connect
    ? await dependencies.connect(resolved.url, resolved.token)
    : new Mcp(resolved.url, resolved.token)
  try {
    if (!dependencies.connect) await (client as Mcp).initialize()
    const task = await source.lookup(client, key.toUpperCase())
    if (!task)
      throw new Error(
        `task ${key.toUpperCase()} was not found in project ${project.name}'s tracker by its single-task lookup`,
      )
    ;(dependencies.upsert ?? upsertTrackerTask)(task)
    return { trackerRead: true, commentsVerifiable: false }
  } finally {
    await client.close()
  }
}

export async function createTrackerOwnedTask(
  input: TrackerOwnedTaskInput,
  options: {
    allowDuplicateReason?: string
    afterDuplicateSearch?: () => void
  } = {},
): Promise<string | null> {
  const project = projects().find((candidate) => candidate.name === input.project)
  if (!project) throw new Error(`unknown project '${input.project}'`)
  if (taskCreationDestination(project) !== 'tracker') return null

  const task = trackerTaskInput(project, input)
  const candidates = duplicateCandidates(listTasks({ project: input.project }), input.title)
  options.afterDuplicateSearch?.()
  if (candidates.length && options.allowDuplicateReason === undefined)
    throw new DuplicateTaskError(candidates)

  const tracker = project.settings.tracker!
  const env = tracker.envPrefix ?? project.settings.envPrefix
  if (!env) throw new Error(`project ${project.name} has no usable tracker configured`)
  const auth = await credentials(env)
  if (!auth) throw new Error(`credentials for ${project.name} tracker do not resolve`)
  const client = new Mcp(auth.url, auth.token)
  try {
    await client.initialize()
    return await createAdvertisedTrackerTaskKey(client, project, task)
  } finally {
    await client.close()
  }
}
