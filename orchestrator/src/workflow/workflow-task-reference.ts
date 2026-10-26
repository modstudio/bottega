// concern: workflows
/** Resolves a workflow task label through the injectable hub task-list port. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { bottegaEntryArgv } from '../../../shared/self-spawn.ts'

export type HubTaskReference = { key: string; record_id: string; project: string }
export type HubTaskReader = (project: string) => Promise<HubTaskReference[]>

export function taskReadRefusal(project: string, detail: string): Error {
  return new Error(
    `could not read task data for project ${project}: ${detail}; retry: ${PLATFORM_SLUG} task list --project ${project} --json`,
  )
}

export async function readHubTasks(project: string): Promise<HubTaskReference[]> {
  const child = Bun.spawn(
    [...bottegaEntryArgv(PLATFORM_SLUG), 'task', 'list', '--project', project, '--json'],
    { stdout: 'pipe', stderr: 'pipe', env: { ...process.env } },
  )
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(stderr.trim() || `exit status ${code}`)
  const rows: unknown = JSON.parse(stdout)
  if (!Array.isArray(rows)) throw new Error('response was not an array')
  return rows.map((row) => {
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
  })
}

/** A reader failure is a refusal; callers with best-effort policy catch it explicitly. */
export async function resolveHubTaskReference(
  project: string,
  key: string,
  reader: HubTaskReader = readHubTasks,
): Promise<HubTaskReference | null> {
  let rows: HubTaskReference[]
  try {
    rows = await reader(project)
  } catch (error) {
    throw taskReadRefusal(project, error instanceof Error ? error.message : String(error))
  }
  return rows.find((task) => task.key === key) ?? null
}
