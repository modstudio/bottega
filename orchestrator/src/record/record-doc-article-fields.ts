/** Resolves and persists hosted document article fields. */
import type { SQL } from 'bun'
import type { DocForm, DocKind } from '../../../shared/docs.ts'
import { newRecordId } from '../../../shared/record/schema.ts'
import { articleFieldRefusal } from '../doc/doc-write-allowed.ts'
import { assertWrite, RecordDocError } from './record-doc-errors.ts'
import { recordDocList } from './record-doc-list-shape.ts'

type Row = Record<string, unknown>
type Fields = {
  form: DocForm | null
  articleSubjectId: string | null
  relatedSubjectIds: string[]
  sourceFiles: string[]
}

export type HostedArticleResponse = {
  form?: DocForm | null
  articleSubject?: { id: string; name: string } | null
  relatedSubjects?: Array<{ id: string; name: string }>
  sourceFiles?: string[]
}

export async function hostedArticleProjectId(
  tx: SQL,
  spaceId: string,
  name: string | null | undefined,
): Promise<string | null> {
  if (!name) return null
  const rows = await tx`SELECT id FROM project WHERE space_id=${spaceId}::uuid AND name=${name}`
  if (rows.length !== 1) {
    throw new RecordDocError(
      `project ${name} has no hosted row in record space ${spaceId}; run \`orch project push\` to create it`,
      422,
    )
  }
  return String(rows[0]!.id)
}

export async function resolveHostedArticleFields(
  tx: SQL,
  input: {
    spaceId: string
    subject: string | null
    scope: string
    kind: DocKind
    form?: DocForm | null
    articleSubjectId?: string | null
    relatedSubjectIds?: string[]
    sourceFiles?: string[]
  },
  existing: Row | undefined,
  projectId: string | null,
): Promise<Fields & { subjectRows: Row[] }> {
  const form =
    input.form === undefined
      ? existing?.form == null
        ? null
        : (String(existing.form) as DocForm)
      : input.form
  const articleSubjectId =
    input.articleSubjectId === undefined
      ? existing?.article_subject_id == null
        ? null
        : String(existing.article_subject_id)
      : input.articleSubjectId
  const existingRelated = existing
    ? await tx`SELECT subject_id FROM doc_related_subject WHERE space_id=${input.spaceId}::uuid AND doc_id=${String(existing.id)}::uuid`
    : []
  const relatedSubjectIds =
    input.relatedSubjectIds ?? existingRelated.map((row: Row) => String(row.subject_id))
  const sourceFiles =
    input.sourceFiles ??
    recordDocList(existing?.source_files, {
      document:
        existing?.id == null ? `${input.scope}/${input.subject ?? '_'}` : String(existing.id),
      column: 'doc.source_files',
      optional: true,
    }).map(String)
  assertWrite(
    articleFieldRefusal({
      scope: input.scope,
      kind: input.kind,
      form,
      ownSubjectId: articleSubjectId,
      relatedSubjectIds,
      sourceFiles,
    }),
  )
  const attached = new Set(
    [existing?.article_subject_id, ...existingRelated.map((row: Row) => row.subject_id)]
      .filter(Boolean)
      .map(String),
  )
  const subjectIds = [
    ...new Set([articleSubjectId, ...relatedSubjectIds].filter((id): id is string => Boolean(id))),
  ]
  const subjectRows = subjectIds.length
    ? await tx`SELECT id,name,retired_at FROM subject WHERE space_id=${input.spaceId}::uuid AND project_id=${projectId}::uuid AND id = ANY(${tx.array(subjectIds, 'uuid')})`
    : []
  for (const id of subjectIds) {
    const row = subjectRows.find((candidate: Row) => String(candidate.id) === id)
    if (!row)
      throw new RecordDocError(
        `subject ${id} is not in the document project; cleared by: orch subject list ${input.subject}`,
      )
    if (row.retired_at != null && !attached.has(id))
      throw new RecordDocError(
        `subject ${id} is retired; cleared by: orch subject list ${input.subject}`,
      )
  }
  return { form, articleSubjectId, relatedSubjectIds, sourceFiles, subjectRows }
}

export function restoredArticleFields(revision: Row): Fields {
  const document = `revision ${String(revision.id)} of document ${String(revision.doc_id)}`
  return {
    form: revision.form == null ? null : (String(revision.form) as DocForm),
    articleSubjectId:
      revision.article_subject_id == null ? null : String(revision.article_subject_id),
    relatedSubjectIds: recordDocList(revision.related_subject_ids, {
      document,
      column: 'doc_revision.related_subject_ids',
    }).map(String),
    sourceFiles: recordDocList(revision.source_files, {
      document,
      column: 'doc_revision.source_files',
    }).map(String),
  }
}

export async function replaceHostedRelatedSubjects(
  tx: SQL,
  spaceId: string,
  docId: string,
  relatedSubjectIds: string[],
): Promise<void> {
  await tx`DELETE FROM doc_related_subject WHERE space_id=${spaceId}::uuid AND doc_id=${docId}::uuid`
  for (const subjectId of relatedSubjectIds)
    await tx`INSERT INTO doc_related_subject (id,space_id,doc_id,subject_id) VALUES (${newRecordId()}::uuid,${spaceId}::uuid,${docId}::uuid,${subjectId}::uuid)`
}

export async function importedArticleSubjectNames(
  tx: SQL,
  input: { spaceId: string; subject: string | null },
  projectId: string | null,
  doc: Fields & { scope: string; kind: DocKind },
  revisions: Array<{ articleSubjectId: string | null; relatedSubjectIds: string[] }>,
): Promise<Map<string, string>> {
  assertWrite(
    articleFieldRefusal({
      scope: doc.scope,
      kind: doc.kind,
      form: doc.form,
      ownSubjectId: doc.articleSubjectId,
      relatedSubjectIds: doc.relatedSubjectIds,
      sourceFiles: doc.sourceFiles,
    }),
  )
  const ids = [
    ...new Set(
      [
        doc.articleSubjectId,
        ...doc.relatedSubjectIds,
        ...revisions.flatMap((revision) => [
          revision.articleSubjectId,
          ...revision.relatedSubjectIds,
        ]),
      ].filter((value): value is string => Boolean(value)),
    ),
  ]
  if (!ids.length) return new Map()
  const rows =
    await tx`SELECT id,name FROM subject WHERE space_id=${input.spaceId}::uuid AND project_id=${projectId}::uuid AND id=ANY(${tx.array(ids, 'uuid')})`
  if (rows.length !== ids.length)
    throw new RecordDocError(
      `an article subject is not in the document project; cleared by: orch subject list ${input.subject}`,
    )
  return new Map(rows.map((row: Row) => [String(row.id), String(row.name)]))
}

export function hostedArticleResponse(fields: Fields, names: Map<string, string>) {
  return {
    form: fields.form,
    articleSubject: fields.articleSubjectId
      ? { id: fields.articleSubjectId, name: names.get(fields.articleSubjectId)! }
      : null,
    relatedSubjects: fields.relatedSubjectIds.map((id) => ({ id, name: names.get(id)! })),
    sourceFiles: fields.sourceFiles,
  }
}
