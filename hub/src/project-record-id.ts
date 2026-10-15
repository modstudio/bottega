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

/** Fill NULL project_record_id values from the register by name. Unmatched names stay null. */
function backfillProjectRecordIds(
  conn: Database,
  registered: readonly ProjectRecordIdSource[] = projects(),
): void {
  const named = namedRegisterProjects(registered)
  if (!named.length) return
  for (const { table, column } of PROJECT_RECORD_ID_TABLES) {
    const update = conn.query(
      `UPDATE "${table}" SET project_record_id=? WHERE "${column}"=? AND project_record_id IS NULL`,
    )
    for (const project of named) update.run(project.record_id, project.name)
  }
  const outbox = conn.query(
    `UPDATE hosted_outbox SET routing_project_record_id=?
     WHERE routing_project=? AND routing_project_record_id IS NULL`,
  )
  for (const project of named) outbox.run(project.record_id, project.name)
}

/** Rewrite name snapshots that already carry the project's hosted id. */
function syncProjectNamesFromRegister(
  conn: Database,
  registered: readonly ProjectRecordIdSource[] = projects(),
): void {
  const named = namedRegisterProjects(registered)
  if (!named.length) return
  for (const { table, column } of PROJECT_RECORD_ID_TABLES) {
    const update = conn.query(`UPDATE "${table}" SET "${column}"=? WHERE project_record_id=?`)
    for (const project of named) update.run(project.name, project.record_id)
  }
  const outbox = conn.query(
    `UPDATE hosted_outbox SET routing_project=? WHERE routing_project_record_id=?`,
  )
  for (const project of named) outbox.run(project.name, project.record_id)
}

/** One collect-cycle identity pass: fill missing ids, then names follow the register. */
export function applyProjectRegisterNames(
  conn: Database,
  registered: readonly ProjectRecordIdSource[] = projects(),
): void {
  backfillProjectRecordIds(conn, registered)
  syncProjectNamesFromRegister(conn, registered)
}

function namedRegisterProjects(
  registered: readonly ProjectRecordIdSource[],
): Array<{ name: string; record_id: string }> {
  return registered.flatMap((project) =>
    project.record_id ? [{ name: project.name, record_id: project.record_id }] : [],
  )
}
