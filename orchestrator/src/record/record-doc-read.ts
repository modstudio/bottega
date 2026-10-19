// concern: record-doc-read
/** Owns tenant-bound hosted document reads and audience projection. */
import { SQL } from 'bun'
import { docAudienceRefusal, docBodyForAudience } from '../../../shared/doc-sections.ts'
import {
  type DocAudience,
  type DocAudiences,
  type DocKind,
  type DocStatus,
  effectiveDocSummary,
} from '../../../shared/docs.ts'
import { bindTenant, type TenantPrincipal } from '../../../shared/record/tenant.ts'
import { type RecordCursor, recordCursorAt } from './record-cursor.ts'
import { RecordDocError } from './record-doc-errors.ts'
import { recordDocList } from './record-doc-list-shape.ts'

function hostedDocList(
  value: unknown,
  input: { document: string; column: string; optional?: boolean },
): unknown[] {
  const decoded = recordDocList(value, input)
  if (decoded.unwrapped)
    console.warn(`unwrapped hosted document JSON string list: ${input.document} ${input.column}`)
  return decoded.values
}

import {
  type RecordDoc,
  type RecordDocRevision,
  recordDocRevisionRow,
  recordDocRow,
} from './record-doc-mapping.ts'

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
        ...effectiveDocSummary(doc.summarySource === 'written' ? doc.summary : null, body),
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
    const body = hostedDocBodyForAudience(doc, input.audience)
    return {
      ...doc,
      body,
      ...effectiveDocSummary(doc.summarySource === 'written' ? doc.summary : null, body),
    }
  })
}

export async function listRecordDocRevisions(
  input: Tenant & { id: string; audience?: DocAudience },
): Promise<RecordDocRevision[] | null> {
  return tenant(input, async (tx) => {
    const docs = await tx`
      SELECT id,space_id,scope,subject,slug,audiences,body FROM doc WHERE id=${input.id}::uuid
    `
    if (!docs.length) return null
    const live = docs[0] as Record<string, unknown>
    const liveDocument = {
      scope: String(live.scope),
      subject: live.subject == null ? null : String(live.subject),
      slug: String(live.slug),
      audiences: live.audiences as DocAudiences,
      body: String(live.body),
    }
    const rows = (await tx`
      SELECT r.*, own.name AS article_subject_name,
        COALESCE(NULLIF(author_user.name,''),author_user.email) AS author_name
      FROM doc_revision r
      LEFT JOIN subject own ON own.id=r.article_subject_id
      LEFT JOIN "user" author_user ON author_user.id::text=r.author
      WHERE r.space_id=${String(docs[0]!.space_id)}::uuid AND r.doc_id=${input.id}::uuid
      ORDER BY at DESC, id DESC
    `) as Array<Record<string, unknown>>
    const relatedIds = new Map<string, string[]>()
    for (const row of rows) {
      relatedIds.set(
        String(row.id),
        hostedDocList(row.related_subject_ids, {
          document: `revision ${String(row.id)} of document ${input.id}`,
          column: 'doc_revision.related_subject_ids',
        }).map(String),
      )
    }
    const subjectIds = [...new Set([...relatedIds.values()].flat())]
    const subjects = subjectIds.length
      ? await tx`SELECT id,name FROM subject WHERE space_id=${String(docs[0]!.space_id)}::uuid AND id=ANY(${tx.array(subjectIds, 'uuid')})`
      : []
    const subjectNames = new Map(
      subjects.map((subject: Record<string, unknown>) => [
        String(subject.record_id),
        String(subject.name),
      ]),
    )
    for (const row of rows) {
      row.related_subjects = (relatedIds.get(String(row.id)) ?? []).map((id) => ({
        id,
        name: subjectNames.get(id) ?? '',
      }))
    }
    return recordDocRevisionHistoryForAudience(
      liveDocument,
      rows.map((row) => recordDocRevisionRow(row)),
      input.audience,
    )
  })
}

/** Apply the hosted audience contract to one document body. */
export function hostedDocBodyForAudience(
  document: Pick<RecordDoc, 'scope' | 'subject' | 'slug' | 'audiences' | 'body'>,
  audience?: DocAudience,
): string {
  if (!audience) return document.body
  const address = `${document.scope}/${document.subject ?? '_'}/${document.slug}`
  const refusal = docAudienceRefusal(address, document.audiences, audience)
  if (refusal) throw new RecordDocError(refusal)
  return docBodyForAudience(document.body, audience)
}

export function recordDocRevisionHistoryForAudience(
  liveDocument: Pick<RecordDoc, 'scope' | 'subject' | 'slug' | 'audiences' | 'body'>,
  revisions: readonly RecordDocRevision[],
  audience?: DocAudience,
): RecordDocRevision[] {
  hostedDocBodyForAudience(liveDocument, audience)
  return revisions.map((revision) => {
    if (audience && !revision.audiences.includes(audience)) {
      return { ...revision, body: '', withheldForAudience: true }
    }
    return { ...revision, body: hostedDocBodyForAudience(revision, audience) }
  })
}
