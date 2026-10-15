// concern: project-rename
/** Renames every local orchestrator name snapshot of a project in one store write. */

import { db } from '../database/db.ts'

/** Name columns on rows that also carry integer project_id. */
export const PROJECT_ID_NAME_COLUMNS = [
  ['run', 'repo'],
  ['canon_pack', 'project'],
  ['landing', 'project'],
  ['landing_override', 'project'],
  ['landing_review_carry', 'project'],
  ['landing_triage_snapshot', 'project'],
  ['review_read', 'project'],
  ['doc', 'subject'],
  ['doc_revision', 'subject'],
] as const

/** Name columns on rows that identify the project only by text. */
export const PROJECT_NAME_ONLY_COLUMNS = [
  ['board_claim', 'project'],
  ['board_message', 'author_project'],
  ['board_reach_delivery', 'reader_project'],
  ['branch_landing_record', 'project'],
  ['presence', 'project'],
  ['release_ledger', 'project'],
  ['worker_note_request', 'project'],
  ['workflow_cursor', 'project'],
] as const

/** Rename the local referent last, after every name snapshot has moved. */
export function applyLocalProjectRename(
  current: { id: number },
  currentName: string,
  nextName: string,
): void {
  const d = db()
  for (const [table, column] of PROJECT_ID_NAME_COLUMNS) {
    d.query(
      `UPDATE ${table} SET ${column}=? WHERE project_id=? OR (project_id IS NULL AND ${column}=?)`,
    ).run(nextName, current.id, currentName)
  }
  for (const [table, column] of PROJECT_NAME_ONLY_COLUMNS) {
    d.query(`UPDATE ${table} SET ${column}=? WHERE ${column}=?`).run(nextName, currentName)
  }
  d.query('UPDATE project SET name=? WHERE id=?').run(nextName, current.id)
}
