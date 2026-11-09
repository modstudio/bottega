import { startBounded } from '../../../shared/bounded-process.ts'
// concern: workflows
/** Resolves a workflow task label through the injectable hub task-list port. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { withholdSecretShapedDetail } from '../../../shared/secret-shaped.ts'
import { bottegaEntryArgv } from '../../../shared/self-spawn.ts'

export type HubTaskReference = {
  key: string
  record_id: string
  project: string
  title?: string | null
  parent_key?: string | null
  source?: string | null
  status_category?: string | null
}
export type HubTaskReader = (project: string) => Promise<HubTaskReference[]>
export type HubTaskKeyMap = ReadonlyMap<string, readonly HubTaskReference[]>

export const projectTaskKey = (project: string, key: string) => `${project}\0${key}`

export function taskKeyMap(tasks: readonly HubTaskReference[]): HubTaskKeyMap {
  const result = new Map<string, HubTaskReference[]>()
  for (const task of tasks) {
    const scopedKey = projectTaskKey(task.project, task.key)
    result.set(scopedKey, [...(result.get(scopedKey) ?? []), task])
  }
  return result
}

/** A task key resolves only when exactly one task in the named project has it. */
export function taskReferenceForProjectKey(
  tasks: HubTaskKeyMap,
  project: string,
  key: string,
): HubTaskReference | null {
  const matches = tasks.get(projectTaskKey(project, key)) ?? []
  return matches.length === 1 ? matches[0]! : null
}

export function taskReadRefusal(project: string, detail: string): Error {
  return new Error(
    `could not read task data for project ${project}: ${withholdSecretShapedDetail(detail)}; retry: ${PLATFORM_SLUG} task list --project ${project} --json`,
  )
}

function taskReference(row: unknown): HubTaskReference {
  if (
    !row ||
    typeof row !== 'object' ||
    typeof (row as HubTaskReference).key !== 'string' ||
    typeof (row as HubTaskReference).record_id !== 'string' ||
    typeof (row as HubTaskReference).project !== 'string'
  ) {
    throw new Error('response contained an invalid task row')
  }
  const status = (row as HubTaskReference).status_category
  if (status !== undefined && status !== null && typeof status !== 'string')
    throw new Error('response contained an invalid task status category')
  const source = (row as HubTaskReference).source
  if (source !== undefined && source !== null && typeof source !== 'string')
    throw new Error('response contained an invalid task source')
  const title = (row as HubTaskReference).title
  if (title !== undefined && title !== null && typeof title !== 'string')
    throw new Error('response contained an invalid task title')
  const parent = (row as HubTaskReference).parent_key
  if (parent !== undefined && parent !== null && typeof parent !== 'string')
    throw new Error('response contained an invalid task parent key')
  return row as HubTaskReference
}

export async function taskCommand(command: string[]): Promise<string> {
  const child = await startBounded([...bottegaEntryArgv(PLATFORM_SLUG), ...command], {
    budget: 'self-cli',
    env: { ...process.env },
  })
  const { stdout, stderr, exitCode } = child
  if (exitCode !== 0) throw new Error(stderr.trim() || `exit status ${exitCode}`)
  return stdout.trim()
}

export async function readHubTasks(project: string): Promise<HubTaskReference[]> {
  const response = JSON.parse(
    await taskCommand(['task', 'list', '--project', project, '--json']),
  ) as unknown
  if (!Array.isArray(response)) throw new Error('response was not an array')
  return response.map(taskReference)
}

/** A reader failure is a refusal; callers with best-effort policy catch it explicitly. */
export async function resolveHubTaskReference(
  project: string | null,
  key: string,
  reader: HubTaskReader = readHubTasks,
): Promise<HubTaskReference | null> {
  if (!project) return null
  try {
    const rows = await reader(project)
    return taskReferenceForProjectKey(taskKeyMap(rows), project, key)
  } catch (error) {
    throw taskReadRefusal(project, error instanceof Error ? error.message : String(error))
  }
}

/** Resolve a mirror identity when available without making hub availability a prerequisite. */
export async function bestEffortTaskReference(
  project: string | null,
  key: string,
  reader?: HubTaskReader,
): Promise<HubTaskReference | null> {
  try {
    return await resolveHubTaskReference(project, key, reader)
  } catch {
    return null
  }
}
