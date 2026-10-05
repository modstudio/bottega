import { type ToolCaller, type TrackerSource, trackerSourceFor } from '../../shared/trackers.ts'
import { withLease } from './collect.ts'
import { observeTrackerTask } from './ingest/trackers.ts'
import { credentials, failureDetail, Mcp } from './mcp.ts'
import { projects, type RegisteredProject } from './projects.ts'
import { DuplicateTaskError, duplicateCandidates, listTasks, showTask } from './task.ts'
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
  observe?: typeof observeTrackerTask
  readBack?: typeof showTask
  lease?: typeof withLease
  leaseWaitMs?: number
}

export type FreshTaskResult = {
  trackerRead: boolean
  commentsVerifiable: boolean
  shown?: ReturnType<typeof showTask>
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

/** Refresh one externally tracked task under the collection lease. */
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
  let client: (ToolCaller & { close(): Promise<void> }) | null = null
  try {
    client = dependencies.connect
      ? await dependencies.connect(resolved.url, resolved.token)
      : new Mcp(resolved.url, resolved.token)
    if (!dependencies.connect) await (client as Mcp).initialize()
    const holder = `fresh-task:${key.toUpperCase()}:${process.pid}`
    const leased = await (dependencies.lease ?? withLease)(
      holder,
      async () => {
        const task = await source.lookup!(client!, key.toUpperCase())
        if (!task)
          throw new Error(
            `task ${key.toUpperCase()} was not found in project ${project.name}'s tracker by its single-task lookup`,
          )
        ;(dependencies.observe ?? observeTrackerTask)(task)
        return (dependencies.readBack ?? showTask)(task.key, { project: task.project })
      },
      dependencies.leaseWaitMs,
    )
    if (!leased.ran)
      throw new Error(
        `${leased.heldBy ?? 'another process'} holds the collect lease; fresh task read was not performed`,
      )
    return { trackerRead: true, commentsVerifiable: false, shown: leased.value }
  } catch (error) {
    throw new Error(failureDetail(error, resolved.token))
  } finally {
    if (client) {
      try {
        await client.close()
      } catch (error) {
        throw new Error(failureDetail(error, resolved.token))
      }
    }
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
