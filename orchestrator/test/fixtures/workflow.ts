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
