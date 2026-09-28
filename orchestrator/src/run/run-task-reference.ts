// concern: run task reference
/** Resolves an optional durable hub task identity without making hub availability a dispatch prerequisite. */
import { bottegaEntryArgv } from '../../../shared/self-spawn.ts'

export async function resolveTaskRecordId(project: string, key: string): Promise<string | null> {
  try {
    const child = Bun.spawn(
      [...bottegaEntryArgv('hub'), 'task', 'show', key, '--project', project, '--json'],
      {
        stdout: 'pipe',
        stderr: 'ignore',
        env: { ...process.env },
      },
    )
    const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
    if (code !== 0) return null
    const shown: unknown = JSON.parse(stdout)
    if (!shown || typeof shown !== 'object' || !('task' in shown)) return null
    const task = shown.task
    if (!task || typeof task !== 'object' || !('record_id' in task)) return null
    return typeof task.record_id === 'string' && task.record_id ? task.record_id : null
  } catch {
    return null
  }
}

export async function resolveRunTaskRecordId(input: {
  inherited: string | null | undefined
  project: string | null
  key: string | null
}): Promise<string | null> {
  if (input.inherited) return input.inherited
  if (!input.project || !input.key) return null
  return resolveTaskRecordId(input.project, input.key)
}
