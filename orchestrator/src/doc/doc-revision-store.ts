// concern: local-doc-revisions
/** Owns local revision ordering and compare-and-set facts. Must not know hosted transport or CLI. */

import type { Database } from 'bun:sqlite'
import type { DocAudiences, DocForm, DocKind, DocStatus } from '../../../shared/docs.ts'
import { db, sessionId } from '../database/db.ts'
import { nextEntityNumber } from '../database/entity-number.ts'
import { decodeStoredDocAudiences, encodeStoredDocAudiences } from './doc-audiences-codec.ts'
import type { DocRevision, DocRevisionMetadata } from './doc-read-store.ts'
import { validateHistoricDocAddress } from './doc-subjects.ts'
import { type DocRevisionOp, decideDocRevisionWrite } from './doc-write-allowed.ts'

type RevisionDoc = {
  record_id: string
  scope: string
  subject: string | null
  owner: string | null
  project_record_id: string | null
  slug: string
  title: string
  body: string
  delivery: 'inject' | 'demand'
  audiences: DocAudiences
  parent_record_id: string | null
  position: number
  featured: boolean
  status: DocStatus
  kind: DocKind
  form: DocForm | null
  article_subject_id: string | null
  relatedSubjects: Array<{ id: string; name: string }>
  sourceFiles: string[]
  checkedAgainstCommit: string | null
  summary: string | null
  replacement_slug: string | null
}

export function decideDocRevisionAuthor(input: {
  explicitAuthor?: string
  signedInUserId?: string | null
  session: string | null
}): string {
  if (input.explicitAuthor !== undefined) return input.explicitAuthor.trim()
  return input.signedInUserId ?? input.session ?? 'unknown'
}

export function docWriteIdentity(
  context: { author?: string; reason: string },
  signedInUserId?: string | null,
): {
  author: string
  reason: string
  session: string | null
} {
  const reason = context.reason?.trim()
  if (!reason) {
    throw new Error(
      'doc write reason is required; pass --reason on the CLI or reason through MCP/Hub',
    )
  }
  const session = sessionId()
  const author = decideDocRevisionAuthor({
    explicitAuthor: context.author,
    signedInUserId,
    session,
  })
  if (!author) {
    throw new Error('doc write author must not be empty; omit it to use the session or unknown')
  }
  return { author, reason, session }
}

export function assertLocalRevisionWrite(
  input: { scope: string; expectedRevision?: string },
  current: string | null,
  isCreate: boolean,
): void {
  const decision = decideDocRevisionWrite({
    expected: input.expectedRevision,
    current,
    isCreate,
    scope: input.scope,
  })
  if (!decision.allow) throw new Error(decision.reason)
}

export function currentDocRevision(
  scope: string,
  subject: string | null,
  slug: string,
  owner: string | null = null,
): string | null {
  const row = db()
    .query(
      'SELECT record_id FROM doc_revision WHERE scope=? AND subject IS ? AND owner IS ? AND slug=? ORDER BY number DESC LIMIT 1',
    )
    .get(scope, subject, owner, slug) as { record_id: string } | null
  return row?.record_id ?? null
}

export function latestStoredDocAuthorSession(
  recordId: string,
  database: Database = db(),
): string | null {
  const row = database
    .query<{ session_id: string }, [string]>(
      `SELECT session_id FROM doc_revision
       WHERE doc_record_id=? AND session_id IS NOT NULL AND op <> 'consume'
       ORDER BY number DESC LIMIT 1`,
    )
    .get(recordId)
  return row?.session_id ?? null
}

export function storedDocRevisionAuthorSession(
  recordId: string,
  database: Database = db(),
): string | null {
  const row = database
    .query<{ session_id: string | null }, [string]>(
      'SELECT session_id FROM doc_revision WHERE record_id=?',
    )
    .get(recordId)
  return row?.session_id ?? null
}

export function insertLocalRevision(
  doc: RevisionDoc,
  op: DocRevisionOp,
  identity: { author: string; reason: string; session: string | null },
  at: string,
  recordId: string,
): void {
  db()
    .query(
      `INSERT INTO doc_revision
       (record_id, number, doc_record_id, scope, subject, owner, project_record_id, slug, op, title, body, delivery, audiences, parent_record_id, position, featured, status, kind, form, article_subject_id, related_subject_ids, source_files, checked_against_commit, summary, replacement_slug, author, reason, session_id, at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      recordId,
      nextEntityNumber(db(), 'doc_revision'),
      doc.record_id,
      doc.scope,
      doc.subject,
      doc.owner,
      doc.project_record_id,
      doc.slug,
      op,
      doc.title,
      doc.body,
      doc.delivery,
      encodeStoredDocAudiences(doc.audiences),
      doc.parent_record_id,
      doc.position,
      doc.featured,
      doc.status,
      doc.kind,
      doc.form,
      doc.article_subject_id,
      JSON.stringify(doc.relatedSubjects.map(({ id }) => id)),
      JSON.stringify(doc.sourceFiles),
      doc.checkedAgainstCommit,
      doc.summary,
      doc.replacement_slug,
      identity.author,
      identity.reason,
      identity.session,
      at,
    )
}

export function listStoredDocRevisions(
  scope: string,
  subject: string | null,
  slug: string,
  owner: string | null = null,
): DocRevisionMetadata[] {
  validateHistoricDocAddress(scope, slug)
  const rows = db()
    .query(
      `SELECT number, op, author, reason, at, status, kind, form, article_subject_id, related_subject_ids, source_files, checked_against_commit, summary, replacement_slug, record_id,
              length(CAST(body AS BLOB)) AS bytes
       FROM doc_revision WHERE scope=? AND subject IS ? AND owner IS ? AND slug=? ORDER BY number DESC`,
    )
    .all(scope, subject, owner, slug) as Array<
    Omit<
      DocRevisionMetadata,
      'articleSubject' | 'relatedSubjects' | 'sourceFiles' | 'checkedAgainstCommit'
    > & {
      article_subject_id: string | null
      related_subject_ids: string
      source_files: string
      checked_against_commit: string | null
    }
  >
  const subjectIds = [
    ...new Set(
      rows.flatMap((row) => [
        ...(row.article_subject_id ? [row.article_subject_id] : []),
        ...(JSON.parse(row.related_subject_ids) as string[]),
      ]),
    ),
  ]
  const subjects = new Map<string, { id: string; name: string }>()
  if (subjectIds.length) {
    const placeholders = subjectIds.map(() => '?').join(',')
    for (const row of db()
      .query<{ id: string; name: string }, string[]>(
        `SELECT id,name FROM subject WHERE id IN (${placeholders})`,
      )
      .all(...subjectIds)) {
      subjects.set(row.id, row)
    }
  }
  return rows.map((row) => {
    const relatedIds = JSON.parse(row.related_subject_ids) as string[]
    const {
      article_subject_id,
      related_subject_ids: _,
      source_files,
      checked_against_commit,
      ...metadata
    } = row
    return {
      ...metadata,
      articleSubject: article_subject_id ? (subjects.get(article_subject_id) ?? null) : null,
      relatedSubjects: relatedIds
        .map((id) => subjects.get(id))
        .filter((value): value is { id: string; name: string } => value !== undefined),
      sourceFiles: JSON.parse(source_files) as string[],
      checkedAgainstCommit: checked_against_commit,
    }
  })
}

export function getStoredDocRevision(
  recordId: string,
  owner: string | null = null,
): DocRevision | null {
  const row = db()
    .query('SELECT * FROM doc_revision WHERE record_id=? AND owner IS ?')
    .get(recordId, owner) as
    | (Omit<DocRevision, 'audiences'> & { featured: boolean | number; audiences: string })
    | null
  return row
    ? {
        ...row,
        featured: Boolean(row.featured),
        audiences: decodeStoredDocAudiences(row.audiences),
        articleSubject: row.article_subject_id
          ? (db()
              .query<{ id: string; name: string }, [string]>(
                'SELECT id,name FROM subject WHERE id=?',
              )
              .get(row.article_subject_id) ?? null)
          : null,
        relatedSubjects: (
          JSON.parse(
            (row as unknown as { related_subject_ids: string }).related_subject_ids,
          ) as string[]
        )
          .map((subjectId) =>
            db()
              .query<{ id: string; name: string }, [string]>(
                'SELECT id,name FROM subject WHERE id=?',
              )
              .get(subjectId),
          )
          .filter((subject): subject is { id: string; name: string } => Boolean(subject)),
        sourceFiles: JSON.parse(
          (row as unknown as { source_files: string }).source_files,
        ) as string[],
        checkedAgainstCommit:
          (row as unknown as { checked_against_commit: string | null }).checked_against_commit ??
          null,
      }
    : null
}

export function diffStoredDocRevisions(a: string, b: string, owner: string | null = null): string {
  const left = getStoredDocRevision(a, owner)
  const right = getStoredDocRevision(b, owner)
  if (!left) throw new Error(`no doc revision ${a}`)
  if (!right) throw new Error(`no doc revision ${b}`)
  const x = [
    `status: ${left.status}`,
    `kind: ${left.kind}`,
    `form: ${left.form ?? '-'}`,
    `article subject: ${left.articleSubject?.id ?? '-'}`,
    `related subjects: ${left.relatedSubjects.map(({ id }) => id).join(',')}`,
    `source files: ${left.sourceFiles.join(',')}`,
    `checked against: ${left.checkedAgainstCommit ?? '-'}`,
    `summary: ${left.summary ?? '-'}`,
    `replacement: ${left.replacement_slug ?? '-'}`,
    '',
    ...left.body.split('\n'),
  ]
  const y = [
    `status: ${right.status}`,
    `kind: ${right.kind}`,
    `form: ${right.form ?? '-'}`,
    `article subject: ${right.articleSubject?.id ?? '-'}`,
    `related subjects: ${right.relatedSubjects.map(({ id }) => id).join(',')}`,
    `source files: ${right.sourceFiles.join(',')}`,
    `checked against: ${right.checkedAgainstCommit ?? '-'}`,
    `summary: ${right.summary ?? '-'}`,
    `replacement: ${right.replacement_slug ?? '-'}`,
    '',
    ...right.body.split('\n'),
  ]
  const lengths = Array.from({ length: x.length + 1 }, () =>
    new Array<number>(y.length + 1).fill(0),
  )
  for (let i = x.length - 1; i >= 0; i--)
    for (let j = y.length - 1; j >= 0; j--) {
      lengths[i]![j] =
        x[i] === y[j]
          ? lengths[i + 1]![j + 1]! + 1
          : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!)
    }
  const lines = [`--- revision-${left.number}`, `+++ revision-${right.number}`]
  let i = 0
  let j = 0
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) {
      lines.push(` ${x[i]}`)
      i++
      j++
    } else if (j < y.length && (i === x.length || lengths[i]![j + 1]! > lengths[i + 1]![j]!)) {
      lines.push(`+${y[j++]}`)
    } else lines.push(`-${x[i++]}`)
  }
  return `${lines.join('\n')}\n`
}
