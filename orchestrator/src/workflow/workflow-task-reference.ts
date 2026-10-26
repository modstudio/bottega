// concern: workflows
/** Resolves a workflow task label through the injectable hub task-list port. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { withholdSecretShapedDetail } from '../../../shared/secret-shaped.ts'
import { bottegaEntryArgv } from '../../../shared/self-spawn.ts'

export type HubTaskReference = { key: string; record_id: string; project: string }
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
  return row as HubTaskReference
}

async function taskCommand(command: string[]): Promise<unknown> {
  const child = Bun.spawn([...bottegaEntryArgv(PLATFORM_SLUG), ...command], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env },
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(stderr.trim() || `exit status ${code}`)
  return JSON.parse(stdout)
}

export async function readHubTasks(project: string): Promise<HubTaskReference[]> {
  const response = await taskCommand(['task', 'list', '--project', project, '--json'])
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
  return parseHubTaskResponse(await taskCommand(['task', 'show', key, '--json']))
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
