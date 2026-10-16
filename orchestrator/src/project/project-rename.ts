// concern: project-rename
/** Owns an atomic local project rename and register-row update. */
import { db, writeTransaction } from '../database/db.ts'
import { upsertProject } from './projects.ts'

const PROJECT_ID_NAME_COLUMNS = [
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

const PROJECT_NAME_ONLY_COLUMNS = [
  ['board_claim', 'project'],
  ['board_message', 'author_project'],
  ['board_reach_delivery', 'reader_project'],
  ['branch_landing_record', 'project'],
  ['presence', 'project'],
  ['release_ledger', 'project'],
  ['worker_note_request', 'project'],
  ['workflow_cursor', 'project'],
] as const

function applyLocalProjectRename(
  current: { recordId: string },
  currentName: string,
  nextName: string,
): void {
  const database = db()
  for (const [table, column] of PROJECT_ID_NAME_COLUMNS) {
    if (table === 'doc' || table === 'doc_revision') {
      database
        .query(`UPDATE ${table} SET ${column}=? WHERE project_record_id=? AND ${column}=?`)
        .run(nextName, current.recordId, currentName)
      continue
    }
    database.query(`UPDATE ${table} SET ${column}=? WHERE project_record_id=?`).run(nextName, current.recordId)
  }
  for (const [table, column] of PROJECT_NAME_ONLY_COLUMNS) {
    database.query(`UPDATE ${table} SET ${column}=? WHERE ${column}=?`).run(nextName, currentName)
  }
  database.query('UPDATE project SET name=? WHERE record_id=?').run(nextName, current.recordId)
}

/** Owns the complete local register mutation so rename and upsert cannot split. */
export function persistLocalProjectSet(
  current: { recordId: string } | null,
  currentName: string,
  nextName: string,
  candidate: Parameters<typeof upsertProject>[0],
): void {
  writeTransaction(() => {
    if (current) applyLocalProjectRename(current, currentName, nextName)
    upsertProject(candidate)
  })
}
