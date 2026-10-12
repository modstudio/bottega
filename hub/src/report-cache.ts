import type { Database } from 'bun:sqlite'
import type { HostedSend } from './hosted-reports.ts'

export function cacheHostedSend(conn: Database, row: HostedSend) {
  const updated = conn
    .query(`UPDATE send SET at=?,window=?,recipients=?,projects=?,items=?,status=?,error=?,test=?
      WHERE record_id=?`)
    .run(
      row.at,
      row.window,
      row.recipients,
      row.projects,
      row.items,
      row.status,
      row.error,
      row.test,
      row.id,
    )
  if (!updated.changes)
    conn
      .query(`INSERT INTO send(record_id,at,window,recipients,projects,items,status,error,test)
    VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(
        row.id,
        row.at,
        row.window,
        row.recipients,
        row.projects,
        row.items,
        row.status,
        row.error,
        row.test,
      )
}
