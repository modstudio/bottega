import { writeTransaction } from './db.ts'
import type { RegisteredTaskSpace } from './task-project-space.ts'
import { taskKeyPrefix } from './task-identity.ts'

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
export function correctIntervalProjects<T extends StoredIntervalProject>(
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
        const update = conn.query(`UPDATE interval SET project=? WHERE record_id=?`)
        for (const row of changed) update.run(row.project_name, row.id)
      })
  }
  return corrected
}
