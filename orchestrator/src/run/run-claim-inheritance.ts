// concern: run-claim-inheritance
/** Reads the root facts a retained turn inherits while it is claimed. */

import { db } from '../database/db.ts'

export function inheritedRunBinding(
  parent: string | undefined,
  binding: { cursorRecordId: string; stepSlug: string } | undefined,
): { cursorRecordId: string | null; stepSlug: string | null } | null {
  if (!parent) return binding ?? null
  const facts = inheritedRunFacts(parent)
  return { cursorRecordId: facts.cursor_record_id, stepSlug: facts.step_slug }
}

export const bindingValues = (
  binding: { cursorRecordId: string | null; stepSlug: string | null } | null,
) => [binding?.cursorRecordId ?? null, binding?.stepSlug ?? null] as const

export function inheritedRunFacts(parent: string): {
  launch_cwd: string | null
  launch_seed: string | null
  launch_key: string | null
  launch_base: string | null
  no_failover: number
  task_record_id: string | null
  project_record_id: string | null
  branch: string | null
  cursor_record_id: string | null
  step_slug: string | null
} {
  return db()
    .query(
      `SELECT launch_cwd, launch_seed, launch_key, launch_base, no_failover,
              task_record_id, project_record_id, branch, cursor_record_id, step_slug
         FROM run WHERE record_id=?`,
    )
    .get(parent) as ReturnType<typeof inheritedRunFacts>
}

export function inheritedRunLinks(parent: string): {
  taskRecordId: string | null
  projectRecordId: string | null
  projectName: string | null
} {
  const facts = inheritedRunFacts(parent)
  const project = facts.project_record_id
    ? (db()
        .query<{ name: string }, [string]>('SELECT name FROM project WHERE record_id=?')
        .get(facts.project_record_id) ?? null)
    : null
  return {
    taskRecordId: facts.task_record_id,
    projectRecordId: facts.project_record_id,
    projectName: project?.name ?? null,
  }
}
