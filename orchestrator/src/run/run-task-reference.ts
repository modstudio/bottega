// concern: run task reference
/** Resolves an optional durable bottega task identity without making hub availability a dispatch prerequisite. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { bottegaEntryArgv } from '../../../shared/self-spawn.ts'
import { projects } from '../project/projects.ts'
import { deriveRunLinks, type HubTaskReference, type RunLinkFacts } from './run-task-linking.ts'

export const RUN_REFERENCE_REFUSAL =
  'a run that is not a probe must reference a task or a project; run from a registered project or pass a task key'

/** Refuses a run before its insert reaches the store backstop. */
export function assertRunHasTaskOrProject(input: {
  probe: boolean
  taskRecordId: string | null
  projectRecordId: string | null
}): void {
  if (!input.probe && !input.taskRecordId && !input.projectRecordId) {
    throw new Error(RUN_REFERENCE_REFUSAL)
  }
}

async function resolveTaskReference(
  project: string | null,
  key: string,
): Promise<HubTaskReference | null> {
  try {
    const child = Bun.spawn(
      [
        ...bottegaEntryArgv(PLATFORM_SLUG),
        'task',
        'show',
        key,
        ...(project ? ['--project', project] : []),
        '--json',
      ],
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
    if (
      !task ||
      typeof task !== 'object' ||
      !('record_id' in task) ||
      !('key' in task) ||
      !('project' in task) ||
      typeof task.record_id !== 'string' ||
      typeof task.key !== 'string' ||
      typeof task.project !== 'string'
    )
      return null
    return { record_id: task.record_id, key: task.key, project: task.project }
  } catch {
    return null
  }
}

/** Applies the link-run derivation to the facts available before a new row is inserted. */
export async function resolveNewRunLinks(input: {
  recordId: string
  job: string
  inheritedTaskRecordId?: string | null
  projectName: string | null
  projectRecordId: string | null
  key: string | null
  cwd: string | null
  launchCwd: string | null
  probe: boolean
  parentRunRecordId?: string | null
}): Promise<{ taskRecordId: string | null; projectRecordId: string | null }> {
  const task = input.key ? await resolveTaskReference(input.projectName, input.key) : null
  const taskMap = new Map<string, HubTaskReference>()
  if (task) taskMap.set(task.key, task)
  const facts: RunLinkFacts = {
    record_id: input.recordId,
    job: input.job,
    launch_key: input.key,
    review_ref: null,
    branch: null,
    cwd: input.cwd,
    launch_cwd: input.launchCwd,
    probe: input.probe ? 1 : 0,
    parent_run_record_id: input.parentRunRecordId ?? null,
    task_record_id: input.inheritedTaskRecordId ?? null,
    project_record_id: input.projectRecordId,
  }
  const derived = deriveRunLinks([facts], taskMap, projects())[0]!
  return {
    taskRecordId: derived.task_record_id ?? facts.task_record_id,
    projectRecordId: derived.project_record_id ?? facts.project_record_id,
  }
}
