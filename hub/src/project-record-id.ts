// concern: project-record-id
/** Store the hosted project UUID beside a hub row's project name. */
import type { Database } from 'bun:sqlite'
import { projects } from './projects.ts'

export type ProjectRecordIdSource = {
  name: string
  record_id?: string | null
}

export function projectRecordIdFor(
  name: string | null | undefined,
  registered: readonly ProjectRecordIdSource[] = projects(),
): string | null {
  if (!name) return null
  return registered.find((project) => project.name === name)?.record_id ?? null
}

const PROJECT_RECORD_ID_TABLES = [
  { table: 'task', column: 'project' },
  { table: 'note', column: 'project' },
  { table: 'note_counter', column: 'project' },
  { table: 'interval', column: 'project' },
  { table: 'question', column: 'project' },
  { table: 'task_identity_claim', column: 'project' },
] as const

/** Rewrite name snapshots that already carry the project's hosted id. */
function syncProjectNamesFromRegister(
  conn: Database,
  registered: readonly ProjectRecordIdSource[] = projects(),
): void {
  const named = namedRegisterProjects(registered)
  if (!named.length) return
  for (const { table, column } of PROJECT_RECORD_ID_TABLES) {
    const update = conn.query(
      `UPDATE "${table}" SET "${column}"=? WHERE project_record_id=? AND "${column}" IS NOT ?`,
    )
    for (const project of named) update.run(project.name, project.record_id, project.name)
  }
  const outbox = conn.query(
    `UPDATE hosted_outbox SET routing_project=? WHERE routing_project_record_id=? AND routing_project IS NOT ?`,
  )
  for (const project of named) outbox.run(project.name, project.record_id, project.name)
}

/** Keep display-name snapshots aligned with UUID-addressed register rows. */
export function applyProjectRegisterNames(
  conn: Database,
  registered: readonly ProjectRecordIdSource[] = projects(),
): void {
  syncProjectNamesFromRegister(conn, registered)
}

function namedRegisterProjects(
  registered: readonly ProjectRecordIdSource[],
): Array<{ name: string; record_id: string }> {
  return registered.flatMap((project) =>
    project.record_id ? [{ name: project.name, record_id: project.record_id }] : [],
  )
}
