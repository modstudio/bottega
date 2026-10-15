import { db, writeTransaction } from './db.ts'
import { projectRecordIdFor } from './project-record-id.ts'
import { projects } from './projects.ts'
import { taskKeyPrefix } from './task-identity.ts'
import type { RegisteredTaskSpace } from './task-project-space.ts'

type StoredIntervalProject = {
  id: string
  task_key: string | null
  project_name: string | null
}

/** Point an interval from an unknown project at the sole registered owner of its task prefix. */
export function intervalOwningProject(
  project: string | null,
  taskKey: string | null,
  registered: readonly RegisteredTaskSpace[],
): string | null {
  if (project === null || registered.some((candidate) => candidate.name === project)) return project
  const prefix = taskKey ? taskKeyPrefix(taskKey) : undefined
  if (!prefix) return project
  const owners = registered.filter((candidate) =>
    candidate.settings.keyPrefixes?.some(
      (candidatePrefix) => candidatePrefix.toUpperCase() === prefix,
    ),
  )
  return owners.length === 1 ? owners[0]!.name : project
}

/** Correct legacy stored interval projects before evidence routing reads them. */
function correctIntervalProjects<T extends StoredIntervalProject>(
  rows: readonly T[],
  registered: readonly RegisteredTaskSpace[],
  persist: boolean,
): T[] {
  const corrected = rows.map((row) => ({
    ...row,
    project_name: intervalOwningProject(row.project_name, row.task_key, registered),
  }))
  if (persist) {
    const changed = corrected.filter((row, index) => row.project_name !== rows[index]!.project_name)
    if (changed.length > 0)
      writeTransaction((conn) => {
        const update = conn.query(
          `UPDATE interval SET project=?, project_record_id=? WHERE record_id=?`,
        )
        for (const row of changed)
          update.run(row.project_name, projectRecordIdFor(row.project_name), row.id)
      })
  }
  return corrected
}

/** Persist legacy project corrections before the hosted outbox is drained. */
export function correctStoredIntervalProjects(
  registered: readonly RegisteredTaskSpace[] = projects(),
): void {
  const rows = db()
    .query<StoredIntervalProject, []>(
      `SELECT record_id id,task_key,project project_name FROM interval ORDER BY record_id`,
    )
    .all()
  correctIntervalProjects(rows, registered, true)
}
