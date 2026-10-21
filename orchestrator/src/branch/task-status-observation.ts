// concern: branch lifecycle evidence
/** Reads one task's status through the task concern's existing CLI owner. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { bottegaEntryArgv } from '../../../shared/self-spawn.ts'
import { type StatusCategory, TASK_STATUSES } from '../../../shared/trackers.ts'

export type TaskStatusObservation = {
  raw: string | null
  category: StatusCategory | null
  verified: boolean
  detail: string
}

export function observeTaskStatus(key: string | null, project: string): TaskStatusObservation {
  if (!key) return { raw: null, category: null, verified: false, detail: 'unkeyed' }
  const result = Bun.spawnSync(
    [...bottegaEntryArgv(PLATFORM_SLUG), 'task', 'show', key, '--project', project, '--json'],
    { stdout: 'pipe', stderr: 'pipe', env: process.env },
  )
  if (result.exitCode !== 0) {
    const detail = result.stderr.toString().trim() || `exit ${result.exitCode}`
    return { raw: null, category: null, verified: false, detail: `unverified (${detail})` }
  }
  try {
    const parsed = JSON.parse(result.stdout.toString()) as {
      task?: { status?: unknown; status_category?: unknown }
    }
    const raw = typeof parsed.task?.status === 'string' ? parsed.task.status : null
    const candidate = parsed.task?.status_category
    const category = TASK_STATUSES.find((status) => status === candidate) ?? null
    if (!category) {
      const detail =
        candidate == null
          ? 'unverified (missing status category)'
          : `unverified (unknown status category ${JSON.stringify(candidate)})`
      return { raw, category: null, verified: false, detail }
    }
    return { raw, category, verified: true, detail: raw ?? category }
  } catch {
    return {
      raw: null,
      category: null,
      verified: false,
      detail: 'unverified (invalid task response)',
    }
  }
}
