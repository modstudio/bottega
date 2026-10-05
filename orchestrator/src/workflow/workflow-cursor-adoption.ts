// concern: workflow cursor task adoption
/** Atomically adopts a task key and republishes every cursor-bound question. */
import type { Database } from 'bun:sqlite'
import { nowIso } from '../database/db.ts'
import { enqueueQuestionRecord } from '../run/question-outbox.ts'

type AdoptionCursor = {
  id: number
  project: string
  workflow_slug: string
  mode_slug: string
  workflow_key: string
  args: string
}

export function vacateRetiredWorkflowKeySlot(
  project: string,
  workflow: string,
  mode: string,
  key: string,
  d: Database,
): void {
  d.query(
    `UPDATE workflow_cursor SET instance_id=instance_id || '#' || id
     WHERE project=? AND workflow_slug=? AND mode_slug=? AND workflow_key=? AND instance_id=''
       AND state IN ('done','abandoned')`,
  ).run(project, workflow, mode, key)
}

function assignWorkflowTaskKey(row: AdoptionCursor, key: string, d: Database): void {
  vacateRetiredWorkflowKeySlot(row.project, row.workflow_slug, row.mode_slug, key, d)
  const adoptedArgs = { ...(JSON.parse(row.args) as Record<string, string>), key }
  d.query(
    "UPDATE workflow_cursor SET workflow_key=?,instance_id='',args=?,updated_at=? WHERE id=?",
  ).run(key, JSON.stringify(adoptedArgs), nowIso(), row.id)
  row.workflow_key = key
  row.args = JSON.stringify(adoptedArgs)
  const questions = d
    .query<{ id: number }, [number]>(
      'SELECT id FROM question WHERE workflow_cursor_id=? ORDER BY id',
    )
    .all(row.id)
  for (const question of questions) {
    d.query('UPDATE question SET workflow_key=?,revision=revision+1 WHERE id=?').run(
      key,
      question.id,
    )
    enqueueQuestionRecord(d, question.id)
  }
}

export function adoptWorkflowTask(
  row: AdoptionCursor,
  suppliedTask: string | undefined,
  d: Database,
): void {
  const key = suppliedTask?.trim()
  if (!key) return
  if (row.workflow_key) {
    if (row.workflow_key !== key)
      throw new Error(
        `cursor ${row.id} is already assigned to ${row.workflow_key}; it cannot adopt ${key}`,
      )
    return
  }
  const conflict = d
    .query<{ id: number }, [string, string, string, string]>(
      `SELECT id FROM workflow_cursor
       WHERE project=? AND workflow_slug=? AND mode_slug=? AND workflow_key=?
         AND state NOT IN ('done','abandoned') LIMIT 1`,
    )
    .get(row.project, row.workflow_slug, row.mode_slug, key)
  if (conflict)
    throw new Error(
      `cursor ${row.id} cannot adopt ${key}; open cursor ${conflict.id} already holds it`,
    )
  assignWorkflowTaskKey(row, key, d)
}
