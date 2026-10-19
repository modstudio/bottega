// concern: docs
/** Read-only document identity resolution shared by workflow evidence and other edges. */
import type { Database } from 'bun:sqlite'
import { hasRecordIdShape } from '../../../shared/record-id.ts'

export type ResolvedDocReference = {
  recordId: string
  scope: string
  subject: string | null
  slug: string
  projectName: string | null
  address: string
}

export function resolveDocReference(value: string, d: Database): ResolvedDocReference | null {
  let address: [string, string | null, string] | null = null
  if (!hasRecordIdShape(value)) {
    const first = value.indexOf('/')
    const second = first < 0 ? -1 : value.indexOf('/', first + 1)
    if (first > 0 && second > first + 1 && second < value.length - 1)
      address = [
        value.slice(0, first),
        value.slice(first + 1, second) === '_' ? null : value.slice(first + 1, second),
        value.slice(second + 1),
      ]
  }
  const row = hasRecordIdShape(value)
    ? d
        .query<
          {
            record_id: string
            scope: string
            subject: string | null
            slug: string
            project_name: string | null
          },
          [string]
        >(
          `SELECT doc.record_id,doc.scope,doc.subject,doc.slug,p.name project_name FROM doc LEFT JOIN project p ON p.record_id=doc.project_record_id WHERE doc.record_id=?`,
        )
        .get(value)
    : address
      ? d
          .query<
            {
              record_id: string
              scope: string
              subject: string | null
              slug: string
              project_name: string | null
            },
            [string, string | null, string]
          >(
            `SELECT doc.record_id,doc.scope,doc.subject,doc.slug,p.name project_name FROM doc LEFT JOIN project p ON p.record_id=doc.project_record_id WHERE doc.scope=? AND doc.subject IS ? AND doc.slug=?`,
          )
          .get(...address)
      : null
  return row
    ? {
        recordId: row.record_id,
        scope: row.scope,
        subject: row.subject,
        slug: row.slug,
        projectName: row.project_name,
        address: `${row.scope}/${row.subject ?? '_'}/${row.slug}`,
      }
    : null
}
