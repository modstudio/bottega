import { credentials, Mcp } from './mcp.ts'
import { projects } from './projects.ts'
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
