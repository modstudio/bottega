import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { credentials, Mcp } from './mcp.ts'
import {
  getNote,
  promoteNote,
  promotionTaskInput,
  promotionTitleRefusal,
  requiredPromotionTitle,
} from './note.ts'
import { projects } from './projects.ts'
import { machineAttribution } from './task-machine-attribution.ts'
import {
  createAdvertisedTrackerTaskKey,
  taskCreationDestination,
  trackerTaskInput,
} from './tracker-new.ts'

export type PromotionFlags = {
  task?: string
  taskFlagPresent: boolean
  title?: string
  titleFlagPresent: boolean
}

type PromotionTarget = { taskKey: string; title: undefined } | { taskKey: undefined; title: string }

function promotionTaskKey(value: string | undefined, present: boolean): string | undefined {
  if (!present) return undefined
  if (!value?.trim())
    throw new Error(
      `--task requires a task key: ${PLATFORM_SLUG} note promote <LABEL|UUID|NUMBER> --task <KEY>`,
    )
  return value
}

/**
 * `--title` names the task a promotion creates, so it is required exactly when `--task` links no
 * existing one; the two flags answer the same question and are refused together.
 */
export function promotionFlags(input: PromotionFlags): PromotionTarget {
  const taskKey = promotionTaskKey(input.task, input.taskFlagPresent)
  if (taskKey === undefined) {
    if (!input.titleFlagPresent) throw new Error(promotionTitleRefusal('<LABEL>'))
    return { taskKey: undefined, title: requiredPromotionTitle('<LABEL>', input.title) }
  }
  if (input.titleFlagPresent)
    throw new Error(
      `--title names the task a promotion creates, but --task links the existing one: ${PLATFORM_SLUG} note promote <LABEL|UUID|NUMBER> --task ${taskKey}`,
    )
  return { taskKey, title: undefined }
}

export async function promoteNoteCommand(id: string, flags: PromotionFlags) {
  const target = promotionFlags(flags)
  const note = getNote(id)
  const project = projects().find((candidate) => candidate.name === note.project)
  if (!project) throw new Error(`unknown project '${note.project}'`)
  let existingTaskKey = target.taskKey
  let created = false
  if (target.taskKey === undefined && taskCreationDestination(project) === 'tracker') {
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
        trackerTaskInput(project, promotionTaskInput(note, target.title)),
      )
      created = true
    } finally {
      await client.close()
    }
  }
  const attribution = await machineAttribution()
  try {
    return await promoteNote(id, { existingTaskKey, title: target.title, attribution })
  } catch (error) {
    if (!created) throw error
    throw new Error(
      `tracker task ${existingTaskKey} was created, but note promotion failed: ${(error as Error).message}. Finish with: ${PLATFORM_SLUG} note promote ${note.label} --task ${existingTaskKey}`,
    )
  }
}
