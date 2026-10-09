// concern: local-doc-revisions
/** Owns local revision ordering and compare-and-set facts. Must not know hosted transport or CLI. */

import type { DocAudiences, DocKind, DocStatus } from '../../../shared/docs.ts'
import { db, sessionId } from '../database/db.ts'
import { decodeStoredDocAudiences, encodeStoredDocAudiences } from './doc-audiences-codec.ts'
import type { DocRevision, DocRevisionMetadata } from './doc-read-store.ts'
import { validateHistoricDocAddress } from './doc-subjects.ts'
import { type DocRevisionOp, decideDocRevisionWrite } from './doc-write-allowed.ts'

type RevisionDoc = {
  id: number
  scope: string
  subject: string | null
  owner: string | null
  project_id: number | null
  slug: string
  title: string
  body: string
  delivery: 'inject' | 'demand'
  audiences: DocAudiences
  parent_id: number | null
  position: number
  featured: boolean
  status: DocStatus
  kind: DocKind
  replacement_slug: string | null
}

export function docWriteIdentity(context: { author?: string; reason: string }): {
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
  const author = (context.author ?? session ?? 'unknown').trim()
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
      'SELECT record_id FROM doc_revision WHERE scope=? AND subject IS ? AND owner IS ? AND slug=? ORDER BY id DESC LIMIT 1',
    )
    .get(scope, subject, owner, slug) as { record_id: string | null } | null
  return row?.record_id ?? null
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
       (doc_id, scope, subject, owner, project_id, slug, op, title, body, delivery, audiences, parent_id, position, featured, status, kind, replacement_slug, author, reason, session_id, at, record_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      doc.id,
      doc.scope,
      doc.subject,
      doc.owner,
      doc.project_id,
      doc.slug,
      op,
      doc.title,
      doc.body,
      doc.delivery,
      encodeStoredDocAudiences(doc.audiences),
      doc.parent_id,
      doc.position,
      doc.featured,
      doc.status,
      doc.kind,
      doc.replacement_slug,
      identity.author,
      identity.reason,
      identity.session,
      at,
      recordId,
    )
}

export function listStoredDocRevisions(
  scope: string,
  subject: string | null,
  slug: string,
  owner: string | null = null,
): DocRevisionMetadata[] {
  validateHistoricDocAddress(scope, slug)
  return db()
    .query(
      `SELECT id, op, author, reason, at, status, kind, replacement_slug, record_id,
              length(CAST(body AS BLOB)) AS bytes
       FROM doc_revision WHERE scope=? AND subject IS ? AND owner IS ? AND slug=? ORDER BY id DESC`,
    )
    .all(scope, subject, owner, slug) as DocRevisionMetadata[]
}

export function getStoredDocRevision(id: number, owner: string | null = null): DocRevision | null {
  const row = db().query('SELECT * FROM doc_revision WHERE id=? AND owner IS ?').get(id, owner) as
    | (Omit<DocRevision, 'audiences'> & { featured: boolean | number; audiences: string })
    | null
  return row
    ? {
        ...row,
        featured: Boolean(row.featured),
        audiences: decodeStoredDocAudiences(row.audiences),
      }
    : null
}

export function diffStoredDocRevisions(a: number, b: number, owner: string | null = null): string {
  const left = getStoredDocRevision(a, owner)
  const right = getStoredDocRevision(b, owner)
  if (!left) throw new Error(`no doc revision ${a}`)
  if (!right) throw new Error(`no doc revision ${b}`)
  const x = [
    `status: ${left.status}`,
    `kind: ${left.kind}`,
    `replacement: ${left.replacement_slug ?? '-'}`,
    '',
    ...left.body.split('\n'),
  ]
  const y = [
    `status: ${right.status}`,
    `kind: ${right.kind}`,
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
  const lines = [`--- revision-${a}`, `+++ revision-${b}`]
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
