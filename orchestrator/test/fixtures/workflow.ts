import type { Database } from 'bun:sqlite'
import { newRecordId } from '../../../shared/record-id.ts'

export function workflowVersionRecordId(database: Database, slug = 'ship-task', n = 1): string {
  let row = database
    .query<{ record_id: string }, [string, number]>(
      `SELECT version.record_id
         FROM workflow_version version
         JOIN workflow ON workflow.record_id=version.workflow_record_id
        WHERE workflow.slug=? AND version.n=? AND workflow.space_id IS NULL`,
    )
    .get(slug, n)
  if (!row) {
    const workflowRecordId = newRecordId()
    const versionRecordId = newRecordId()
    database
      .query(
        "INSERT INTO workflow(record_id,slug,created_at,space_id,generation) VALUES (?,?,'fixture',NULL,1)",
      )
      .run(workflowRecordId, slug)
    database
      .query(
        `INSERT INTO workflow_version
          (record_id,workflow_record_id,n,status,definition,author,reason,created_at,promoted_at,space_id)
         VALUES (?,?,?,'production','{}','fixture','fixture','fixture','fixture',NULL)`,
      )
      .run(versionRecordId, workflowRecordId, n)
    row = { record_id: versionRecordId }
  }
  return row.record_id
}

export function catalogueVersionRecordId(database: Database, n = 1): string {
  let row = database
    .query<{ record_id: string }, [number]>(
      `SELECT version.record_id
         FROM step_catalogue_version version
         JOIN step_catalogue catalogue ON catalogue.record_id=version.catalogue_record_id
        WHERE catalogue.slug='shared' AND version.n=? AND catalogue.space_id IS NULL`,
    )
    .get(n)
  if (!row) {
    const catalogueRecordId = newRecordId()
    const versionRecordId = newRecordId()
    database
      .query(
        "INSERT INTO step_catalogue(record_id,slug,created_at,space_id,generation) VALUES (?,'shared','fixture',NULL,1)",
      )
      .run(catalogueRecordId)
    database
      .query(
        `INSERT INTO step_catalogue_version
          (record_id,catalogue_record_id,n,status,definition,author,reason,created_at,promoted_at,space_id)
         VALUES (?,?,?,'production','{}','fixture','fixture','fixture','fixture',NULL)`,
      )
      .run(versionRecordId, catalogueRecordId, n)
    row = { record_id: versionRecordId }
  }
  return row.record_id
}

export function addOpenCursorWorktree(
  database: Database,
  input: { project: string; worktree: string },
): number {
  const cursor = database
    .query<{ number: number }, string[]>(
      `INSERT INTO workflow_cursor
        (record_id,number,project,workflow_slug,mode_slug,workflow_key,instance_id,session_id,
         workflow_version_record_id,catalogue_version_record_id,args,ordinal,step_slug,state,closed,
         question,total_steps,created_at,updated_at,enforcement)
       VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM workflow_cursor),?,'ship-task',
               'default','','',NULL,?,?,?,0,'review-lenses','running','[]',NULL,1,
               '2026-10-30','2026-10-30','floors') RETURNING number`,
    )
    .get(
      newRecordId(),
      input.project,
      workflowVersionRecordId(database),
      catalogueVersionRecordId(database),
      JSON.stringify({ worktree: input.worktree }),
    )
  return cursor!.number
}
