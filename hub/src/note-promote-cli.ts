import { credentials, Mcp } from './mcp.ts'
import { getNote, promoteNote, promotionTaskInput } from './note.ts'
import { projects } from './projects.ts'
import {
  createAdvertisedTrackerTaskKey,
  taskCreationDestination,
  trackerTaskInput,
} from './tracker-new.ts'

export function promotionTaskKey(value: string | undefined, present: boolean): string | undefined {
  if (!present) return undefined
  if (!value?.trim())
    throw new Error('--task requires a task key: hub note promote <ID> --task <KEY>')
  return value
}

export async function promoteNoteCommand(
  id: string,
  suppliedTaskKey?: string,
  taskFlagPresent = suppliedTaskKey !== undefined,
) {
  suppliedTaskKey = promotionTaskKey(suppliedTaskKey, taskFlagPresent)
  const note = getNote(id)
  const project = projects().find((candidate) => candidate.name === note.project)
  if (!project) throw new Error(`unknown project '${note.project}'`)
  let existingTaskKey = suppliedTaskKey
  let created = false
  if (taskCreationDestination(project) === 'tracker' && !existingTaskKey) {
    const tracker = project.settings.tracker!
    const env = tracker.envPrefix ?? project.settings.envPrefix
    if (!env) throw new Error(`project ${project.name} has no usable tracker configured`)
    const auth = await credentials(env)
    if (!auth) throw new Error(`credentials for ${project.name} tracker do not resolve`)
    const client = new Mcp(auth.url, auth.token)
    try {
      await client.initialize()
      existingTaskKey = await createAdvertisedTrackerTaskKey(
        client,
        project,
        trackerTaskInput(project, promotionTaskInput(note)),
      )
      created = true
    } finally {
      await client.close()
    }
  }
  try {
    return await promoteNote(id, { existingTaskKey })
  } catch (error) {
    if (!created) throw error
    throw new Error(
      `tracker task ${existingTaskKey} was created, but note promotion failed: ${(error as Error).message}. Finish with: hub note promote ${note.id} --task ${existingTaskKey}`,
    )
  }
}
