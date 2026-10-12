// concern: record-doc-read
/** Owns tenant-bound hosted document reads and audience projection. */
import { SQL } from 'bun'
import { docAudienceRefusal, docBodyForAudience } from '../../../shared/doc-sections.ts'
import { type DocAudience, type DocKind, type DocStatus, docSummary } from '../../../shared/docs.ts'
import { bindTenant, type TenantPrincipal } from '../../../shared/record/tenant.ts'
import { type RecordCursor, recordCursorAt } from './record-cursor.ts'
import { RecordDocError } from './record-doc-errors.ts'
import { type RecordDoc, type RecordDocRevision, recordDocRow } from './record-doc-mapping.ts'

type Tenant = { url: string } & TenantPrincipal

export type RecordDocListInput = {
  scope?: string
  subject?: string | null
  audience?: DocAudience
  status?: DocStatus
  kind?: DocKind
  updatedSince?: string
  limit: number
  cursor: RecordCursor | null
  includeDeleted: boolean
  acrossReadableSpaces: boolean
}

async function tenant<T>(input: Tenant, read: (tx: SQL) => Promise<T>): Promise<T> {
  const client = new SQL(input.url)
  try {
    return await client.begin(async (tx) => {
      await bindTenant(tx, input)
      return read(tx)
    })
  } finally {
    await client.close()
  }
}

export async function listRecordDocs(input: Tenant & RecordDocListInput): Promise<RecordDoc[]> {
  return tenant(input, async (tx) => {
    const spaceIds = input.spaceIds?.length ? input.spaceIds : [input.spaceId]
    const selectedSpaceIds = input.acrossReadableSpaces ? spaceIds : [input.spaceId]
    const rows = await tx`
      SELECT d.*, s.name AS space_name, p.name AS project_name,
        own.name AS article_subject_name,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('id',rs.id,'name',rs.name) ORDER BY rs.position,rs.id) FROM doc_related_subject dr JOIN subject rs ON rs.id=dr.subject_id WHERE dr.space_id=d.space_id AND dr.doc_id=d.id),'[]'::jsonb) AS related_subjects,
        to_char(d.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
      FROM doc d
      JOIN space s ON s.id=d.space_id
      LEFT JOIN project p ON p.id=d.project_id
      LEFT JOIN subject own ON own.id=d.article_subject_id
      WHERE d.space_id = ANY(string_to_array(${selectedSpaceIds.join(',')}, ',')::uuid[])
        AND (${input.scope ?? null}::text IS NULL OR d.scope=${input.scope ?? null})
        AND (${input.audience ?? null}::text IS NULL OR ${input.audience ?? null}=ANY(d.audiences))
        AND (${input.status ?? null}::text IS NULL OR d.status=${input.status ?? null})
        AND (${input.kind ?? null}::text IS NULL OR d.kind=${input.kind ?? null})
        AND (
          ${input.subject === undefined}::boolean
          OR (${input.subject === null}::boolean AND d.subject IS NULL)
          OR d.subject=${input.subject ?? null}
        )
        AND (${input.includeDeleted}::boolean OR d.deleted_at IS NULL)
        AND (
          ${input.updatedSince ?? null}::timestamptz IS NULL
          OR d.updated_at > ${input.updatedSince ?? null}::timestamptz
        )
        AND (
          ${input.cursor?.at ?? null}::timestamptz IS NULL
          OR (d.updated_at, d.id) > (${input.cursor?.at ?? null}::timestamptz, ${input.cursor?.id ?? null}::uuid)
        )
      ORDER BY d.updated_at, d.id
      LIMIT ${input.limit + 1}
    `
    return rows.map((row: Record<string, unknown>) => {
      const doc = recordDocRow(row)
      const body = input.audience ? docBodyForAudience(doc.body, input.audience) : doc.body
      return {
        ...doc,
        body,
        summary: docSummary(body),
        [recordCursorAt]: String(row.cursor_at),
      }
    })
  })
}

export async function getRecordDoc(
  input: Tenant & { id: string; audience?: DocAudience },
): Promise<RecordDoc | null> {
  return tenant(input, async (tx) => {
    const rows = await tx`
      SELECT d.*, s.name AS space_name, p.name AS project_name, own.name AS article_subject_name,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('id',rs.id,'name',rs.name) ORDER BY rs.position,rs.id) FROM doc_related_subject dr JOIN subject rs ON rs.id=dr.subject_id WHERE dr.space_id=d.space_id AND dr.doc_id=d.id),'[]'::jsonb) AS related_subjects
      FROM doc d
      JOIN space s ON s.id=d.space_id
      LEFT JOIN project p ON p.id=d.project_id
      LEFT JOIN subject own ON own.id=d.article_subject_id
      WHERE d.id=${input.id}::uuid
    `
    if (!rows[0]) return null
    const doc = recordDocRow(rows[0] as Record<string, unknown>)
    if (!input.audience) return doc
    const address = `${doc.scope}/${doc.subject ?? '_'}/${doc.slug}`
    const refusal = docAudienceRefusal(address, doc.audiences, input.audience)
    if (refusal) throw new RecordDocError(refusal)
    return { ...doc, body: docBodyForAudience(doc.body, input.audience) }
  })
}

/** Apply the current-document audience contract to a saved revision. */
export function recordDocRevisionForAudience(
  revision: RecordDocRevision,
  audience?: DocAudience,
): RecordDocRevision {
  if (!audience) return revision
  const address = `${revision.scope}/${revision.subject ?? '_'}/${revision.slug}`
  const refusal = docAudienceRefusal(address, revision.audiences, audience)
  if (refusal) throw new RecordDocError(refusal)
  return { ...revision, body: docBodyForAudience(revision.body, audience) }
}
