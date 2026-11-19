// concern: record-cache-counts
/** Counts the hosted rows that can populate a machine's local document cache. */

import { bindTenant } from '../../../shared/record/tenant.ts'
import { docWriteProjectName } from '../doc/doc-write-allowed.ts'
import type { RecordDocumentTenant } from './record-api-doc-tenant.ts'
import { recordPool } from './record-pool.ts'

export type RecordCacheCounts = {
  byScope: Array<{ scope: string; project: string | null; docs: number }>
  subjectsByProject: Array<{ project: string; subjects: number }>
}

export async function countRecordCacheRows(
  input: RecordDocumentTenant,
): Promise<RecordCacheCounts> {
  return recordPool(input.url).begin(async (tx) => {
    await bindTenant(tx, input)
    const docs = await tx`
      SELECT scope,subject,count(*)::integer AS docs
      FROM doc
      WHERE space_id=${input.spaceId}::uuid AND deleted_at IS NULL
      GROUP BY scope,subject
      ORDER BY scope,subject NULLS FIRST
    `
    const subjects = await tx`
      SELECT p.name AS project,count(*)::integer AS subjects
      FROM subject s
      JOIN project p ON p.space_id=s.space_id AND p.id=s.project_id
      WHERE s.space_id=${input.spaceId}::uuid
      GROUP BY p.name
      ORDER BY p.name
    `
    const grouped = new Map<string, RecordCacheCounts['byScope'][number]>()
    for (const row of docs as Array<Record<string, unknown>>) {
      const scope = String(row.scope)
      const project = docWriteProjectName(scope, row.subject == null ? null : String(row.subject))
      const key = JSON.stringify([scope, project])
      const prior = grouped.get(key)
      grouped.set(key, { scope, project, docs: (prior?.docs ?? 0) + Number(row.docs) })
    }
    return {
      byScope: [...grouped.values()].sort(
        (left, right) =>
          left.scope.localeCompare(right.scope) ||
          (left.project ?? '').localeCompare(right.project ?? ''),
      ),
      subjectsByProject: subjects.map((row: Record<string, unknown>) => ({
        project: String(row.project),
        subjects: Number(row.subjects),
      })),
    }
  })
}
