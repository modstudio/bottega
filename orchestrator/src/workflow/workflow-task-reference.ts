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
  source?: string | null
  status_category?: string | null
}
export type HubTaskReader = (project: string) => Promise<HubTaskReference[]>
export type HubTaskByKeyReader = (key: string) => Promise<HubTaskReference | null>

export function taskReadRefusal(project: string | null, key: string, detail: string): Error {
  const scope = project ? `project ${project}` : `key ${key}`
  const command = project
    ? `${PLATFORM_SLUG} task list --project ${project} --json`
    : `${PLATFORM_SLUG} task show ${key} --json`
  return new Error(
    `could not read task data for ${scope}: ${withholdSecretShapedDetail(detail)}; retry: ${command}`,
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

export function parseHubTaskResponse(response: unknown): HubTaskReference {
  if (!response || typeof response !== 'object' || !('task' in response)) {
    throw new Error('response did not contain a task')
  }
  return taskReference((response as { task: unknown }).task)
}

async function readHubTask(key: string): Promise<HubTaskReference | null> {
  return parseHubTaskResponse(JSON.parse(await taskCommand(['task', 'show', key, '--json'])))
}

/** A reader failure is a refusal; callers with best-effort policy catch it explicitly. */
export async function resolveHubTaskReference(
  project: string | null,
  key: string,
  reader: HubTaskReader = readHubTasks,
  keyReader: HubTaskByKeyReader = readHubTask,
): Promise<HubTaskReference | null> {
  try {
    if (!project) return await keyReader(key)
    const rows = await reader(project)
    const matches = rows.filter((task) => task.key === key && task.project === project)
    return matches.length === 1 ? matches[0]! : null
  } catch (error) {
    throw taskReadRefusal(project, key, error instanceof Error ? error.message : String(error))
  }
}
